package de.mucumba.jerry.core;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLWarning;
import java.sql.Savepoint;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;
import javax.sql.DataSource;

/** A workspace owns a physical JDBC lease until explicit close or server-side expiry. */
public final class SqlService implements AutoCloseable {
  private final Config config;
  private final Audit audit;
  private final DataSources sources;
  private final Path root;
  private final ConcurrentMap<String, Workspace> workspaces = new ConcurrentHashMap<>();
  private final ThreadPoolExecutor workers;
  private final ThreadPoolExecutor cancellations;
  private final AtomicLong spoolBytes = new AtomicLong();
  private final long spoolLimit;
  private volatile boolean stopped;

  static final class Workspace {
    final String id = UUID.randomUUID().toString(), owner, user, source;
    final Connection connection;
    final boolean readOnly;
    final ReentrantLock lock = new ReentrantLock();
    final Map<String, Savepoint> savepoints =
        Collections.synchronizedMap(new LinkedHashMap<String, Savepoint>());
    final Map<String, String> seenRequests = new LinkedHashMap<>();
    final ConcurrentMap<String, QueryResult> results = new ConcurrentHashMap<>();
    volatile long lastUse = System.currentTimeMillis(), transactionSince;
    volatile boolean closing, autoCommit, transactionOpen, requiresRollback;
    volatile Statement activeStatement;
    volatile Job job;
    long previewBytes;
    final String product, dialect, originalCatalog, originalSchema;
    final boolean originalAutoCommit, originalReadOnly;
    final int originalIsolation, originalNetworkTimeout;

    Workspace(String owner, String user, String source, Connection connection, boolean readOnly)
        throws SQLException {
      this.owner = owner;
      this.user = user;
      this.source = source;
      this.connection = connection;
      this.readOnly = readOnly;
      originalAutoCommit = connection.getAutoCommit();
      originalReadOnly = connection.isReadOnly();
      originalIsolation = connection.getTransactionIsolation();
      originalCatalog = connection.getCatalog();
      String schema = null;
      int network = 0;
      try {
        schema = connection.getSchema();
      } catch (SQLException | AbstractMethodError ignored) {
      }
      try {
        network = connection.getNetworkTimeout();
      } catch (SQLException | AbstractMethodError ignored) {
      }
      originalSchema = schema;
      originalNetworkTimeout = network;
      product = connection.getMetaData().getDatabaseProductName();
      dialect = dialect(product);
      if (!connection.getMetaData().supportsTransactions())
        throw new SQLException("Diese Datenquelle unterstützt keine Transaktionen.");
      connection.setReadOnly(readOnly);
      connection.setAutoCommit(false);
    }
  }

  static final class Job {
    final String id, fingerprint;
    final long started = System.currentTimeMillis();
    volatile long finished;
    volatile String state = "QUEUED", error, sqlState;
    volatile int vendorCode;
    volatile boolean cancelled;
    final List<Map<String, Object>> steps =
        Collections.synchronizedList(new ArrayList<Map<String, Object>>());

    Job(String requestId, String sql) {
      id = requestId;
      fingerprint = Audit.fingerprint(sql);
    }

    Map<String, Object> data() {
      return data(true);
    }

    Map<String, Object> data(boolean previews) {
      List<Map<String, Object>> copy = new ArrayList<>();
      synchronized (steps) {
        for (Map<String, Object> step : steps) {
          synchronized (step) {
            Map<String, Object> snapshot = new LinkedHashMap<>(step);
            Object values = snapshot.get("results");
            if (values instanceof List)
              synchronized (values) {
                List<Object> outputs = new ArrayList<>();
                for (Object item : (List<?>) values) {
                  if (!previews
                      && item instanceof Map
                      && "rows".equals(((Map<?, ?>) item).get("type"))) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> output = new LinkedHashMap<>((Map<String, Object>) item);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> result =
                        new LinkedHashMap<>((Map<String, Object>) output.get("result"));
                    result.put("rows", Collections.emptyList());
                    output.put("result", result);
                    outputs.add(output);
                  } else outputs.add(item);
                }
                snapshot.put("results", outputs);
              }
            copy.add(snapshot);
          }
        }
      }
      return Json.map(
          "id",
          id,
          "state",
          state,
          "started",
          started,
          "finished",
          finished,
          "steps",
          copy,
          "error",
          error,
          "sqlState",
          sqlState,
          "vendorCode",
          vendorCode);
    }
  }

  static final class QueryResult {
    final String id = UUID.randomUUID().toString();
    final Path file;
    final List<Map<String, Object>> columns = new ArrayList<>();
    final List<List<String>> preview = new ArrayList<>();
    final List<Long> offsets = new ArrayList<>();
    long count, bytes;
    boolean truncated, cellTruncated;

    QueryResult(Path file) {
      this.file = file;
    }

    Map<String, Object> data() {
      return Json.map(
          "id",
          id,
          "columns",
          columns,
          "rows",
          preview,
          "rowCount",
          count,
          "truncated",
          truncated,
          "cellTruncated",
          cellTruncated,
          "bytes",
          bytes,
          "previewCount",
          preview.size());
    }
  }

  public SqlService(Config config, Audit audit, DataSources sources) throws IOException {
    this.config = config;
    this.audit = audit;
    this.sources = sources;
    root = config.dataDirectory.resolve("sql-results");
    Files.createDirectories(root);
    // Result files have no meaning after process restart: a transaction cannot be restored.
    try (java.nio.file.DirectoryStream<Path> paths = Files.newDirectoryStream(root, "*.rows")) {
      for (Path path : paths) Files.deleteIfExists(path);
    }
    int concurrency = config.number("sql.workers", 4, 1, 16);
    workers =
        new ThreadPoolExecutor(
            concurrency,
            concurrency,
            0,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<Runnable>(32),
            new Workers("sql"),
            new ThreadPoolExecutor.AbortPolicy());
    cancellations =
        new ThreadPoolExecutor(
            2,
            2,
            0,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<Runnable>(32),
            new Workers("sql-cancel"),
            new ThreadPoolExecutor.AbortPolicy());
    spoolLimit = config.number("sql.spool.mb", 512, 16, 4096) * 1024L * 1024;
  }

  /** Opens an owner-bound JDBC workspace with auto-commit disabled. */
  public synchronized Map<String, Object> open(
      String owner, String user, String source, boolean readOnlyOnly) throws Exception {
    if (stopped) throw new IllegalStateException("Jerry wird beendet.");
    if (workspaces.size() >= config.number("sql.sessions.max", 16, 1, 64))
      throw new IllegalStateException("Maximale Anzahl SQL-Verbindungen erreicht.");
    int owned = 0, sameSource = 0;
    for (Workspace workspace : workspaces.values()) {
      if (workspace.owner.equals(owner)) owned++;
      if (workspace.source.equals(source)) sameSource++;
    }
    if (owned >= 4 || sameSource >= config.number("sql.sessions.perSource", 4, 1, 16))
      throw new IllegalStateException("Verbindungslimit pro Benutzer oder Datenquelle erreicht.");
    if (readOnlyOnly && !sources.enforcedReadOnly(source))
      throw new SecurityException(
          "SQL-Leserechte erfordern eine separat konfigurierte Datenquelle mit datenbankseitig erzwungenen Leserechten.");
    DataSource dataSource = sources.resolve(source);
    Connection connection = dataSource.getConnection();
    try {
      Workspace workspace = new Workspace(owner, user, source, connection, readOnlyOnly);
      try {
        connection.setNetworkTimeout(
            cancellations, config.number("sql.networkTimeout.seconds", 120, 10, 1800) * 1000);
      } catch (SQLException | AbstractMethodError ignored) {
      }
      workspaces.put(workspace.id, workspace);
      audit.event(user, "sql.open", source, "OK");
      return status(workspace);
    } catch (Exception exception) {
      try {
        connection.rollback();
      } catch (SQLException ignored) {
      }
      connection.close();
      throw exception;
    }
  }

  private Workspace owned(String owner, String id) {
    Workspace workspace = workspaces.get(id);
    if (workspace == null || !workspace.owner.equals(owner) || workspace.closing)
      throw new IllegalArgumentException("SQL-Sitzung ist abgelaufen oder nicht zugänglich.");
    return workspace;
  }

  public Map<String, Object> status(String owner, String id) {
    return status(owned(owner, id));
  }

  public Map<String, Object> status(String owner, String id, boolean previews) {
    return status(owned(owner, id), previews);
  }

  private Map<String, Object> status(Workspace workspace) {
    return status(workspace, true);
  }

  private Map<String, Object> status(Workspace workspace, boolean previews) {
    Job job = workspace.job;
    List<String> savepointNames;
    synchronized (workspace.savepoints) {
      savepointNames = new ArrayList<>(workspace.savepoints.keySet());
    }
    return Json.map(
        "id",
        workspace.id,
        "source",
        workspace.source,
        "product",
        workspace.product,
        "dialect",
        workspace.dialect,
        "readOnly",
        workspace.readOnly,
        "autoCommit",
        workspace.autoCommit,
        "transactionOpen",
        workspace.transactionOpen,
        "transactionSince",
        workspace.transactionSince,
        "requiresRollback",
        workspace.requiresRollback,
        "lastUse",
        workspace.lastUse,
        "savepoints",
        savepointNames,
        "job",
        job == null ? null : job.data(previews));
  }

  public List<Map<String, Object>> list(String owner) {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Workspace workspace : workspaces.values())
      if (workspace.owner.equals(owner) && !workspace.closing) result.add(status(workspace));
    return result;
  }

  /** Queues a bounded script execution; a request ID prevents accidental duplicate execution. */
  public Map<String, Object> execute(String owner, String id, Map<String, Object> input) {
    final Workspace workspace = owned(owner, id);
    final String sql = Json.text(input, "sql", "");
    if (sql.length() > 1000000)
      throw new IllegalArgumentException("SQL-Skript überschreitet 1 MB.");
    final List<String> statements = SqlSplitter.split(sql, workspace.dialect);
    for (String statement : statements) {
      String plain =
          statement.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)--[^\\r\\n]*", " ").trim();
      if (plain.matches(
          "(?is)^(COMMIT|ROLLBACK|SAVEPOINT|RELEASE\\s+SAVEPOINT|SET\\s+(SESSION\\s+)?AUTOCOMMIT|START\\s+TRANSACTION|BEGIN\\s+TRAN(SACTION)?)\\b.*"))
        throw new IllegalArgumentException(
            "Transaktionen bitte über Commit, Rollback, Savepoint und Autocommit steuern.");
    }
    final String requestId = Json.text(input, "requestId", "");
    if (!requestId.matches("[A-Za-z0-9_-]{8,80}"))
      throw new IllegalArgumentException("Eindeutige requestId fehlt.");
    synchronized (workspace) {
      if (workspace.job != null && workspace.job.id.equals(requestId)) {
        if (!workspace.job.fingerprint.equals(Audit.fingerprint(sql)))
          throw new IllegalArgumentException("requestId wurde mit anderem SQL wiederverwendet.");
        return status(workspace);
      }
      if (workspace.seenRequests.containsKey(requestId))
        throw new IllegalStateException(
            "Diese requestId wurde bereits ausgeführt. Das Statement wird nicht erneut gesendet.");
      if (workspace.seenRequests.size() >= 1000)
        throw new IllegalStateException(
            "Maximal 1000 Ausführungen pro Verbindung. Bitte einen neuen Tab öffnen.");
      if (workspace.job != null
          && ("QUEUED".equals(workspace.job.state) || "RUNNING".equals(workspace.job.state)))
        throw new IllegalStateException("In diesem Tab läuft bereits eine Abfrage.");
      if (workspace.requiresRollback)
        throw new IllegalStateException(
            "Vor der nächsten Ausführung ist ein Rollback erforderlich.");
      if (workspace.lock.isLocked())
        throw new IllegalStateException("Die SQL-Verbindung ist beschäftigt.");
      final Job job = new Job(requestId, sql);
      workspace.job = job;
      workspace.seenRequests.put(requestId, job.fingerprint);
      workspace.lastUse = System.currentTimeMillis();
      try {
        workers.execute(() -> run(workspace, job, statements, input));
      } catch (java.util.concurrent.RejectedExecutionException exception) {
        job.state = "ERROR";
        job.error = "SQL-Warteschlange ist voll.";
        throw new IllegalStateException(job.error);
      }
    }
    return status(workspace);
  }

  private void run(
      Workspace workspace, Job job, List<String> statements, Map<String, Object> input) {
    workspace.lock.lock();
    String outcome = "DONE";
    try {
      if (workspace.closing || job.cancelled) {
        outcome = "CANCELLED";
        return;
      }
      deleteResults(workspace);
      job.state = "RUNNING";
      int timeout =
          Json.integer(
              input, "timeout", 60, 1, config.number("sql.queryTimeout.max", 600, 1, 1800));
      for (int index = 0; index < statements.size(); index++) {
        if (job.cancelled || workspace.closing) {
          outcome = "CANCELLED";
          break;
        }
        long begin = System.nanoTime();
        String sql = statements.get(index);
        Map<String, Object> step =
            Collections.synchronizedMap(
                Json.map(
                    "index",
                    index + 1,
                    "sql",
                    sql,
                    "results",
                    Collections.synchronizedList(new ArrayList<Map<String, Object>>())));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> outputs = (List<Map<String, Object>>) step.get("results");
        job.steps.add(step);
        if (!workspace.autoCommit) {
          workspace.transactionOpen = true;
          if (workspace.transactionSince == 0)
            workspace.transactionSince = System.currentTimeMillis();
        }
        try (Statement statement = workspace.connection.createStatement()) {
          workspace.activeStatement = statement;
          statement.setQueryTimeout(timeout);
          try {
            statement.setFetchSize(config.number("sql.fetchSize", 200, 1, 10000));
          } catch (SQLException ignored) {
          }
          boolean resultSet = statement.execute(sql);
          int outputsCount = 0;
          while (true) {
            if (++outputsCount > 100)
              throw new SQLException("Mehr als 100 Ergebnisse pro Statement.");
            if (resultSet) {
              try (ResultSet rows = statement.getResultSet()) {
                QueryResult result = spool(workspace, job, rows, input);
                workspace.results.put(result.id, result);
                outputs.add(Json.map("type", "rows", "result", result.data()));
              }
            } else {
              int updateCount = statement.getUpdateCount();
              if (updateCount == -1) break;
              outputs.add(Json.map("type", "update", "count", updateCount));
            }
            if (job.cancelled || workspace.closing) break;
            resultSet = statement.getMoreResults(Statement.CLOSE_CURRENT_RESULT);
          }
          List<String> warnings = new ArrayList<>();
          for (SQLWarning warning = statement.getWarnings();
              warning != null && warnings.size() < 30;
              warning = warning.getNextWarning()) warnings.add(warning.getMessage());
          step.put("warnings", warnings);
          step.put("state", "DONE");
        } catch (SQLException exception) {
          workspace.requiresRollback = !workspace.autoCommit;
          step.put("state", "ERROR");
          step.put("error", exception.getMessage());
          job.error = exception.getMessage();
          job.sqlState = exception.getSQLState();
          job.vendorCode = exception.getErrorCode();
          outcome = job.cancelled ? "CANCELLED" : "ERROR";
          break;
        } finally {
          workspace.activeStatement = null;
          step.put("durationMs", (System.nanoTime() - begin) / 1000000L);
        }
      }
      if (job.cancelled) outcome = "CANCELLED";
    } catch (Exception exception) {
      outcome = job.cancelled ? "CANCELLED" : "ERROR";
      job.error = exception.getMessage();
      workspace.requiresRollback = !workspace.autoCommit;
    } finally {
      job.finished = System.currentTimeMillis();
      workspace.lastUse = job.finished;
      workspace.activeStatement = null;
      audit.event(
          workspace.user, "sql.execute", workspace.source + ":sha256:" + job.fingerprint, outcome);
      // A terminal state promises that immediate Commit/Rollback can acquire the lease.
      // Serialize publication with execute(), so a new job cannot overtake completion.
      synchronized (workspace) {
        workspace.lock.unlock();
        job.state = outcome;
      }
      if (workspace.closing) dispose(workspace);
    }
  }

  private QueryResult spool(Workspace workspace, Job job, ResultSet rows, Map<String, Object> input)
      throws Exception {
    QueryResult result = new QueryResult(root.resolve(UUID.randomUUID().toString() + ".rows"));
    ResultSetMetaData metadata = rows.getMetaData();
    int columns = metadata.getColumnCount();
    if (columns > 512) throw new SQLException("Maximal 512 Ergebnisspalten.");
    for (int c = 1; c <= columns; c++)
      result.columns.add(
          Json.map(
              "name",
              metadata.getColumnLabel(c),
              "type",
              metadata.getColumnTypeName(c),
              "jdbcType",
              metadata.getColumnType(c)));
    int rowLimit =
        Json.integer(
            input,
            "rowLimit",
            100000,
            1,
            config.number("sql.export.rows.max", 1000000, 1, 10000000));
    int previewRows = Json.integer(input, "previewRows", 200, 1, 1000);
    long byteLimit = config.number("sql.result.mb", 64, 1, 512) * 1024L * 1024;
    int cellLimit = config.number("sql.cell.chars", 65536, 100, 1048576);
    try (BufferedWriter writer = Files.newBufferedWriter(result.file, StandardCharsets.UTF_8)) {
      while (rows.next()) {
        if (job.cancelled || workspace.closing) throw new SQLException("Abfrage abgebrochen.");
        if (result.count >= rowLimit) {
          result.truncated = true;
          break;
        }
        List<String> values = new ArrayList<>(columns);
        for (int c = 1; c <= columns; c++) {
          String value;
          int type = metadata.getColumnType(c);
          if (type == java.sql.Types.BLOB
              || type == java.sql.Types.BINARY
              || type == java.sql.Types.VARBINARY
              || type == java.sql.Types.LONGVARBINARY) {
            try (java.io.InputStream in = rows.getBinaryStream(c)) {
              if (in == null) value = null;
              else {
                java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                byte[] chunk = new byte[4096];
                int read;
                while (buffer.size() < cellLimit
                    && (read = in.read(chunk, 0, Math.min(chunk.length, cellLimit - buffer.size())))
                        != -1) buffer.write(chunk, 0, read);
                if (in.read() != -1) result.cellTruncated = true;
                value =
                    "base64:" + java.util.Base64.getEncoder().encodeToString(buffer.toByteArray());
              }
            }
          } else if (type == java.sql.Types.CLOB
              || type == java.sql.Types.NCLOB
              || type == java.sql.Types.LONGVARCHAR
              || type == java.sql.Types.LONGNVARCHAR
              || type == java.sql.Types.VARCHAR
              || type == java.sql.Types.NVARCHAR
              || type == java.sql.Types.CHAR
              || type == java.sql.Types.NCHAR) {
            try (java.io.Reader reader = rows.getCharacterStream(c)) {
              if (reader == null) value = null;
              else {
                StringBuilder text = new StringBuilder();
                char[] chars = new char[4096];
                int read;
                while (text.length() < cellLimit
                    && (read =
                            reader.read(
                                chars, 0, Math.min(chars.length, cellLimit - text.length())))
                        != -1) text.append(chars, 0, read);
                if (reader.read() != -1) result.cellTruncated = true;
                value = text.toString();
              }
            }
          } else {
            value = rows.getString(c);
            if (value != null && value.length() > cellLimit) {
              value = value.substring(0, cellLimit);
              result.cellTruncated = true;
            }
          }
          values.add(value);
        }
        String line = Json.MAPPER.writeValueAsString(values);
        int bytes = line.getBytes(StandardCharsets.UTF_8).length + 1;
        if (bytes > 2 * 1024 * 1024)
          throw new SQLException(
              "Eine Ergebniszeile überschreitet 2 MB. Große Spalten gezielt auswählen.");
        if (result.bytes + bytes > byteLimit) {
          result.truncated = true;
          break;
        }
        if (spoolBytes.addAndGet(bytes) > spoolLimit) {
          spoolBytes.addAndGet(-bytes);
          throw new IOException("Globales Limit für SQL-Ergebnisse erreicht.");
        }
        if (result.count % 128 == 0) result.offsets.add(result.bytes);
        result.bytes += bytes;
        writer.write(line);
        writer.write('\n');
        result.count++;
        if (result.preview.size() < previewRows
            && workspace.previewBytes + bytes <= 4 * 1024 * 1024) {
          result.preview.add(values);
          workspace.previewBytes += bytes;
        }
      }
    } catch (Exception exception) {
      Files.deleteIfExists(result.file);
      spoolBytes.addAndGet(-result.bytes);
      throw exception;
    }
    return result;
  }

  /** Applies transaction controls to an idle workspace owned by the requesting session. */
  public Map<String, Object> control(
      String owner, String id, String action, Map<String, Object> input) throws Exception {
    Workspace workspace = owned(owner, id);
    if (!workspace.lock.tryLock())
      throw new IllegalStateException("Die Verbindung ist beschäftigt.");
    try {
      Job job = workspace.job;
      if (job != null && "QUEUED".equals(job.state))
        throw new IllegalStateException("Eine Abfrage wartet auf Ausführung.");
      if ("commit".equals(action)) {
        if (workspace.autoCommit) throw new IllegalStateException("Autocommit ist aktiv.");
        if (workspace.requiresRollback)
          throw new IllegalStateException("Nach dem Fehler ist ein Rollback erforderlich.");
        workspace.connection.commit();
        resetTransaction(workspace);
      } else if ("rollback".equals(action)) {
        workspace.connection.rollback();
        resetTransaction(workspace);
      } else if ("autocommit".equals(action)) {
        if (workspace.transactionOpen)
          throw new IllegalStateException(
              "Vor dem Umschalten zuerst Commit oder Rollback ausführen.");
        boolean enabled = Boolean.parseBoolean(Json.text(input, "enabled", "false"));
        workspace.connection.setAutoCommit(enabled);
        workspace.autoCommit = enabled;
      } else if ("savepoint".equals(action)) {
        if (workspace.autoCommit || workspace.requiresRollback)
          throw new IllegalStateException("Savepoint in diesem Zustand nicht möglich.");
        if (workspace.savepoints.size() >= 20)
          throw new IllegalStateException("Maximal 20 Savepoints.");
        String name = Json.text(input, "name", "sp_" + (workspace.savepoints.size() + 1));
        if (!name.matches("[A-Za-z][A-Za-z0-9_]{0,29}"))
          throw new IllegalArgumentException("Ungültiger Savepoint-Name.");
        workspace.savepoints.put(name, workspace.connection.setSavepoint(name));
        workspace.transactionOpen = true;
        if (workspace.transactionSince == 0)
          workspace.transactionSince = System.currentTimeMillis();
      } else if ("rollback-savepoint".equals(action)) {
        String name = Json.text(input, "name", "");
        Savepoint point = workspace.savepoints.get(name);
        if (point == null) throw new IllegalArgumentException("Savepoint existiert nicht.");
        workspace.connection.rollback(point);
        workspace.requiresRollback = false;
        synchronized (workspace.savepoints) {
          boolean remove = false;
          for (String key : new ArrayList<>(workspace.savepoints.keySet())) {
            if (remove) workspace.savepoints.remove(key);
            if (key.equals(name)) remove = true;
          }
        }
      } else if ("schema".equals(action)) {
        if (workspace.transactionOpen)
          throw new IllegalStateException("Schemawechsel erfordert vorher Commit oder Rollback.");
        if ("mysql".equals(workspace.dialect) || "mariadb".equals(workspace.dialect))
          workspace.connection.setCatalog(Json.text(input, "schema", ""));
        else workspace.connection.setSchema(Json.text(input, "schema", ""));
      } else if ("isolation".equals(action)) {
        if (workspace.transactionOpen)
          throw new IllegalStateException(
              "Isolationswechsel erfordert vorher Commit oder Rollback.");
        int level = Json.integer(input, "level", Connection.TRANSACTION_READ_COMMITTED, 1, 8);
        if (!Arrays.asList(1, 2, 4, 8).contains(level))
          throw new IllegalArgumentException("Ungültige Isolation.");
        workspace.connection.setTransactionIsolation(level);
      } else throw new IllegalArgumentException("Unbekannte SQL-Aktion.");
      workspace.lastUse = System.currentTimeMillis();
      audit.event(workspace.user, "sql." + action, workspace.source, "OK");
      return status(workspace);
    } catch (SQLException exception) {
      audit.event(workspace.user, "sql." + action, workspace.source, "ERROR");
      throw exception;
    } finally {
      workspace.lock.unlock();
    }
  }

  private static void resetTransaction(Workspace workspace) {
    workspace.transactionOpen = false;
    workspace.transactionSince = 0;
    workspace.requiresRollback = false;
    workspace.savepoints.clear();
  }

  /** Requests cancellation of the active statement without transferring workspace ownership. */
  public void cancel(String owner, String id) {
    Workspace workspace = owned(owner, id);
    Job job = workspace.job;
    if (job != null) job.cancelled = true;
    Statement statement = workspace.activeStatement;
    if (statement != null)
      cancellations.execute(
          () -> {
            try {
              statement.cancel();
            } catch (SQLException ignored) {
            }
          });
    audit.event(workspace.user, "sql.cancel", workspace.source, "REQUESTED");
  }

  /** Reads JDBC metadata; filtering by schema does not change the connection's current schema. */
  public Map<String, Object> metadata(String owner, String id, String schema, String table)
      throws Exception {
    return metadata(owner, id, schema, table, false);
  }

  /** Reads only the requested table's columns when completion does not need index details. */
  public Map<String, Object> metadata(
      String owner, String id, String schema, String table, boolean columnsOnly) throws Exception {
    Workspace workspace = owned(owner, id);
    if (!workspace.lock.tryLock()) throw new IllegalStateException("Verbindung beschäftigt.");
    try {
      if (workspace.job != null && "QUEUED".equals(workspace.job.state))
        throw new IllegalStateException("Verbindung beschäftigt.");
      workspace.lastUse = System.currentTimeMillis();
      DatabaseMetaData metadata = workspace.connection.getMetaData();
      Map<String, Object> result =
          Json.map(
              "product",
              workspace.product,
              "version",
              metadata.getDatabaseProductVersion(),
              "quote",
              metadata.getIdentifierQuoteString(),
              "catalog",
              workspace.connection.getCatalog(),
              "isolation",
              workspace.connection.getTransactionIsolation(),
              "ddlCommits",
              metadata.dataDefinitionCausesTransactionCommit());
      try {
        result.put("storesUpperCaseIdentifiers", metadata.storesUpperCaseIdentifiers());
        result.put("storesLowerCaseIdentifiers", metadata.storesLowerCaseIdentifiers());
      } catch (SQLException | AbstractMethodError ignored) {
        // Some JDBC drivers do not expose identifier casing; the editor uses a conservative
        // fallback.
      }
      boolean catalogs = "mysql".equals(workspace.dialect) || "mariadb".equals(workspace.dialect);
      String catalog = workspace.connection.getCatalog();
      String currentSchema = null;
      String schemaOrigin = "Nicht ermittelbar";
      try {
        currentSchema = workspace.connection.getSchema();
      } catch (SQLException | AbstractMethodError ignored) {
      }
      if (currentSchema != null && !currentSchema.trim().isEmpty())
        schemaOrigin = "JDBC-Verbindung";
      else currentSchema = null;
      List<Map<String, Object>> schemas = new ArrayList<>();
      if (table == null || table.isEmpty()) {
        try (ResultSet rows = catalogs ? metadata.getCatalogs() : metadata.getSchemas()) {
          schemas = metadataRows(rows);
          if (catalogs)
            for (Map<String, Object> item : schemas) item.put("TABLE_SCHEM", item.get("TABLE_CAT"));
        } catch (SQLException | AbstractMethodError ignored) {
        }
        if (catalogs && catalog != null && !catalog.isEmpty()) {
          currentSchema = catalog;
          schemaOrigin = "JDBC-Katalog";
        }
        if (currentSchema == null && !catalogs) {
          String databaseUser = null;
          try {
            databaseUser = metadata.getUserName();
          } catch (SQLException ignored) {
          }
          String match = null;
          int matches = 0;
          for (Map<String, Object> item : schemas) {
            String candidate = Json.text(item, "TABLE_SCHEM", "");
            if (!candidate.isEmpty() && candidate.equalsIgnoreCase(databaseUser)) {
              match = candidate;
              matches++;
            }
          }
          if (matches == 1) {
            currentSchema = match;
            schemaOrigin = "Passendes Benutzerschema (Fallback)";
          }
        }
        if (currentSchema != null) {
          boolean found = false;
          for (Map<String, Object> item : schemas)
            if (currentSchema.equals(item.get("TABLE_SCHEM"))) found = true;
          if (!found)
            schemas.add(0, Json.map("TABLE_SCHEM", currentSchema, "TABLE_CATALOG", catalog));
        }
        result.put("schemas", schemas);
      }
      String selectedSchema = schema == null ? currentSchema : schema;
      result.put("currentSchema", currentSchema);
      result.put("selectedSchema", selectedSchema);
      result.put("schemaOrigin", schemaOrigin);
      result.put("schemaKind", catalogs ? "catalog" : "schema");
      String selectedCatalog =
          catalogs && selectedSchema != null && !selectedSchema.isEmpty()
              ? selectedSchema
              : catalog;
      String schemaPattern =
          catalogs || selectedSchema == null ? null : escapePattern(metadata, selectedSchema);
      if (table != null && !table.isEmpty()) {
        try (ResultSet rows =
            metadata.getColumns(
                selectedCatalog, schemaPattern, escapePattern(metadata, table), null)) {
          result.put("columns", metadataRows(rows));
        }
        if (columnsOnly) return result;
        try (ResultSet rows =
            metadata.getPrimaryKeys(selectedCatalog, catalogs ? null : selectedSchema, table)) {
          result.put("primaryKeys", metadataRows(rows));
        }
        try (ResultSet rows =
            metadata.getIndexInfo(
                selectedCatalog, catalogs ? null : selectedSchema, table, false, true)) {
          result.put("indexes", metadataRows(rows));
        }
        try (ResultSet rows =
            metadata.getImportedKeys(selectedCatalog, catalogs ? null : selectedSchema, table)) {
          result.put("foreignKeys", metadataRows(rows));
        }
      } else if (selectedSchema != null && !selectedSchema.isEmpty()) {
        try (ResultSet rows =
            metadata.getTables(
                selectedCatalog,
                schemaPattern,
                "%",
                new String[] {"TABLE", "VIEW", "MATERIALIZED VIEW"})) {
          result.put("tables", metadataRows(rows));
        }
        try (ResultSet rows = metadata.getProcedures(selectedCatalog, schemaPattern, "%")) {
          result.put("procedures", metadataRows(rows));
        } catch (SQLException exception) {
          result.put("procedureError", exception.getMessage());
        }
      } else {
        result.put("tables", Collections.emptyList());
        result.put("procedures", Collections.emptyList());
      }
      return result;
    } finally {
      workspace.lock.unlock();
    }
  }

  private static String escapePattern(DatabaseMetaData metadata, String input) throws SQLException {
    String escape = metadata.getSearchStringEscape();
    if (escape == null || escape.isEmpty()) return input;
    return input
        .replace(escape, escape + escape)
        .replace("_", escape + "_")
        .replace("%", escape + "%");
  }

  private static List<Map<String, Object>> metadataRows(ResultSet rows) throws SQLException {
    List<Map<String, Object>> result = new ArrayList<>();
    ResultSetMetaData metadata = rows.getMetaData();
    while (rows.next() && result.size() < 5000) {
      Map<String, Object> row = new LinkedHashMap<>();
      for (int i = 1; i <= metadata.getColumnCount(); i++)
        row.put(metadata.getColumnLabel(i), rows.getString(i));
      result.add(row);
    }
    return result;
  }

  public Map<String, Object> page(String owner, String id, String resultId, int offset, int limit)
      throws IOException {
    QueryResult result = result(owned(owner, id), resultId);
    List<List<String>> rows = new ArrayList<>();
    long bytes = 0;
    if (offset >= result.count)
      return Json.map(
          "rows", rows, "offset", offset, "rowCount", result.count, "truncated", result.truncated);
    int block = offset / 128;
    long index = block * 128L;
    try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(result.file)) {
      channel.position(result.offsets.get(block));
      BufferedReader reader =
          new BufferedReader(
              java.nio.channels.Channels.newReader(
                  channel, StandardCharsets.UTF_8.newDecoder(), -1));
      String line;
      while ((line = reader.readLine()) != null && rows.size() < limit) {
        if (index++ >= offset) {
          bytes += line.length() * 2L;
          if (bytes > 8L * 1024 * 1024 && !rows.isEmpty()) break;
          rows.add(Json.MAPPER.readValue(line, new TypeReference<List<String>>() {}));
        }
      }
    }
    return Json.map(
        "rows", rows, "offset", offset, "rowCount", result.count, "truncated", result.truncated);
  }

  private QueryResult result(Workspace workspace, String id) {
    QueryResult result = workspace.results.get(id);
    if (result == null) throw new IllegalArgumentException("Ergebnis existiert nicht mehr.");
    return result;
  }

  public void export(
      String owner, String id, String resultId, OutputStream output, Map<String, Object> options)
      throws IOException {
    Workspace workspace = owned(owner, id);
    QueryResult result = result(workspace, resultId);
    String separator = Json.text(options, "separator", ";");
    if (!Arrays.asList(";", ",", "\t", "|").contains(separator))
      throw new IllegalArgumentException("Ungültiges Trennzeichen.");
    String encoding = Json.text(options, "encoding", "UTF-8");
    if (!Arrays.asList("UTF-8", "UTF-16LE", "windows-1252").contains(encoding))
      throw new IllegalArgumentException("Ungültiger Zeichensatz.");
    String datePattern = Json.text(options, "datePattern", ""),
        timestampPattern = Json.text(options, "timestampPattern", "");
    if (datePattern.length() > 80 || timestampPattern.length() > 80)
      throw new IllegalArgumentException("Datumsformat ist zu lang.");
    java.time.format.DateTimeFormatter dates =
        datePattern.isEmpty() ? null : java.time.format.DateTimeFormatter.ofPattern(datePattern);
    java.time.format.DateTimeFormatter timestamps =
        timestampPattern.isEmpty()
            ? null
            : java.time.format.DateTimeFormatter.ofPattern(timestampPattern);
    boolean bom = Boolean.parseBoolean(Json.text(options, "bom", "true"));
    if (bom && "UTF-8".equals(encoding))
      output.write(new byte[] {(byte) 0xef, (byte) 0xbb, (byte) 0xbf});
    if (bom && "UTF-16LE".equals(encoding)) output.write(new byte[] {(byte) 0xff, (byte) 0xfe});
    Writer writer = new BufferedWriter(new OutputStreamWriter(output, Charset.forName(encoding)));
    String nullText = Json.text(options, "null", "");
    boolean safe = Boolean.parseBoolean(Json.text(options, "safe", "true"));
    if (Boolean.parseBoolean(Json.text(options, "header", "true"))) {
      List<Object> labels = new ArrayList<>();
      for (Map<String, Object> column : result.columns) labels.add(column.get("name"));
      Csv.row(writer, labels, separator.charAt(0), nullText, safe);
    }
    long maximum =
        "preview".equals(Json.text(options, "scope", "all"))
            ? result.preview.size()
            : Long.MAX_VALUE;
    long count = 0;
    try (BufferedReader reader = Files.newBufferedReader(result.file, StandardCharsets.UTF_8)) {
      String line;
      while (count++ < maximum && (line = reader.readLine()) != null) {
        List<String> values = Json.MAPPER.readValue(line, new TypeReference<List<String>>() {});
        for (int index = 0; index < values.size(); index++) {
          String value = values.get(index);
          if (value == null) continue;
          int type = ((Number) result.columns.get(index).get("jdbcType")).intValue();
          try {
            if (dates != null && type == java.sql.Types.DATE)
              values.set(index, java.time.LocalDate.parse(value).format(dates));
            if (timestamps != null && type == java.sql.Types.TIMESTAMP)
              values.set(
                  index, java.time.LocalDateTime.parse(value.replace(' ', 'T')).format(timestamps));
          } catch (java.time.DateTimeException ignored) {
            /* Preserve driver text if its representation differs from ISO/JDBC. */
          }
        }
        Csv.row(writer, values, separator.charAt(0), nullText, safe);
      }
    }
    writer.flush();
    workspace.lastUse = System.currentTimeMillis();
    audit.event(workspace.user, "sql.export", workspace.source + ":" + result.id, "OK");
  }

  /** Closes the workspace and rolls back any uncommitted transaction. */
  public void close(String owner, String id) {
    closeWorkspace(owned(owner, id));
  }

  public void closeOwner(String owner) {
    for (Workspace workspace : workspaces.values())
      if (workspace.owner.equals(owner)) closeWorkspace(workspace);
  }

  public void reap() {
    long now = System.currentTimeMillis();
    long idle = config.number("sql.idle.minutes", 5, 1, 60) * 60000L;
    long transaction = config.number("sql.transaction.minutes", 15, 1, 240) * 60000L;
    for (Workspace workspace : workspaces.values())
      if (now - workspace.lastUse > idle
          || (workspace.transactionSince > 0 && now - workspace.transactionSince > transaction))
        closeWorkspace(workspace);
  }

  private void closeWorkspace(Workspace workspace) {
    workspace.closing = true;
    Job job = workspace.job;
    if (job != null) job.cancelled = true;
    Statement statement = workspace.activeStatement;
    if (statement != null)
      try {
        cancellations.execute(
            () -> {
              try {
                statement.cancel();
              } catch (SQLException ignored) {
              }
            });
      } catch (java.util.concurrent.RejectedExecutionException ignored) {
      }
    if (workspace.lock.tryLock()) {
      try {
        disposeLocked(workspace);
      } finally {
        workspace.lock.unlock();
      }
    }
  }

  private void dispose(Workspace workspace) {
    workspace.lock.lock();
    try {
      disposeLocked(workspace);
    } finally {
      workspace.lock.unlock();
    }
  }

  private void disposeLocked(Workspace workspace) {
    if (!workspaces.remove(workspace.id, workspace)) return;
    Connection connection = workspace.connection;
    try {
      if (!connection.getAutoCommit()) connection.rollback();
      connection.setReadOnly(workspace.originalReadOnly);
      connection.setTransactionIsolation(workspace.originalIsolation);
      if (workspace.originalCatalog != null) connection.setCatalog(workspace.originalCatalog);
      try {
        if (workspace.originalSchema != null) connection.setSchema(workspace.originalSchema);
      } catch (SQLException | AbstractMethodError ignored) {
      }
      try {
        connection.setNetworkTimeout(cancellations, workspace.originalNetworkTimeout);
      } catch (SQLException | AbstractMethodError ignored) {
      }
      connection.setAutoCommit(workspace.originalAutoCommit);
      connection.clearWarnings();
    } catch (SQLException exception) {
      audit.event(workspace.user, "sql.cleanup", workspace.source, "RESET_FAILED");
      try {
        connection.abort(cancellations);
      } catch (SQLException | AbstractMethodError ignored) {
      }
    } finally {
      try {
        connection.close();
      } catch (SQLException ignored) {
      }
      deleteResults(workspace);
    }
    audit.event(workspace.user, "sql.close", workspace.source, "CLOSED");
  }

  private void deleteResults(Workspace workspace) {
    for (QueryResult result : workspace.results.values())
      try {
        Files.deleteIfExists(result.file);
        spoolBytes.addAndGet(-result.bytes);
      } catch (IOException ignored) {
      }
    workspace.results.clear();
    workspace.previewBytes = 0;
  }

  public Map<String, Object> diagnostics() {
    return Json.map(
        "sessions",
        workspaces.size(),
        "spoolBytes",
        spoolBytes.get(),
        "spoolLimit",
        spoolLimit,
        "activeWorkers",
        workers.getActiveCount(),
        "queued",
        workers.getQueue().size());
  }

  public static String dialect(String product) {
    String lower = product.toLowerCase(Locale.ROOT);
    if (lower.contains("postgres")) return "postgresql";
    if (lower.contains("oracle")) return "oracle";
    if (lower.contains("microsoft") || lower.contains("sql server")) return "sqlserver";
    if (lower.contains("mariadb")) return "mariadb";
    if (lower.contains("mysql")) return "mysql";
    return "standard";
  }

  @Override
  public void close() {
    stopped = true;
    for (Workspace workspace : workspaces.values()) closeWorkspace(workspace);
    workers.shutdownNow();
    try {
      workers.awaitTermination(5, TimeUnit.SECONDS);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
    }
    cancellations.shutdownNow();
  }
}
