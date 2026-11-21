package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SqlServiceTest {
  @TempDir Path temporary;
  private SqlService service;
  private JdbcDataSource source;
  private Audit audit;

  @BeforeEach
  void setup() throws Exception {
    System.setProperty("jerry.data.dir", temporary.toString());
    System.setProperty("jerry.config", temporary.resolve("absent.properties").toString());
    Config config = new Config();
    source = new JdbcDataSource();
    source.setURL("jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
    try (Connection connection = source.getConnection()) {
      connection
          .createStatement()
          .execute("CREATE TABLE sample (id INT PRIMARY KEY, text VARCHAR(100))");
    }
    DataSources provider =
        new DataSources() {
          public List<Map<String, Object>> list() {
            return Collections.emptyList();
          }

          public DataSource resolve(String id) {
            return source;
          }
        };
    audit = new Audit(config);
    service = new SqlService(config, audit, provider);
  }

  @AfterEach
  void close() {
    if (service != null) service.close();
    System.clearProperty("jerry.data.dir");
    System.clearProperty("jerry.config");
    System.clearProperty("jerry.sql.open.timeout.seconds");
    System.clearProperty("jerry.sql.sessions.perSource");
  }

  @Test
  void slowPoolDoesNotBlockOpeningAnotherWorkspaceAndCountsAgainstTheSourceLimit()
      throws Exception {
    System.setProperty("jerry.sql.sessions.perSource", "1");
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    installBlockedSource(entered, release, new AtomicReference<Connection>());
    ExecutorService clients = Executors.newFixedThreadPool(2);
    try {
      Future<?> slow = clients.submit(() -> service.open("alice", "alice", "slow", false));
      assertTrue(entered.await(5, TimeUnit.SECONDS));
      assertThrows(IllegalStateException.class, () -> service.open("bob", "bob", "slow", false));
      Future<Map<String, Object>> fast =
          clients.submit(() -> service.open("bob", "bob", "healthy", false));
      assertEquals(false, fast.get(5, TimeUnit.SECONDS).get("autoCommit"));
      assertFalse(slow.isDone());
      release.countDown();
      slow.get(5, TimeUnit.SECONDS);
    } finally {
      release.countDown();
      clients.shutdownNow();
    }
  }

  @Test
  void timedOutOpenReturnsALateConnectionAndDoesNotPublishAWorkspace() throws Exception {
    System.setProperty("jerry.sql.open.timeout.seconds", "1");
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    AtomicReference<Connection> late = new AtomicReference<>();
    installBlockedSource(entered, release, late);
    try {
      assertThrows(SQLTimeoutException.class, () -> service.open("alice", "alice", "slow", false));
      assertEquals(0, entered.getCount());
      assertTrue(service.list("alice").isEmpty());
    } finally {
      release.countDown();
    }
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while ((late.get() == null || !late.get().isClosed()) && System.nanoTime() < deadline)
      Thread.sleep(10);
    assertNotNull(late.get());
    assertTrue(late.get().isClosed());
    assertTrue(service.list("alice").isEmpty());
  }

  private void installBlockedSource(
      CountDownLatch entered, CountDownLatch release, AtomicReference<Connection> acquired)
      throws Exception {
    service.close();
    DataSource blocked =
        (DataSource)
            Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class},
                (proxy, method, args) -> {
                  if (!"getConnection".equals(method.getName()))
                    throw new UnsupportedOperationException();
                  entered.countDown();
                  if (!release.await(10, TimeUnit.SECONDS))
                    throw new SQLException("Test pool not released");
                  Connection connection = source.getConnection();
                  acquired.set(connection);
                  return connection;
                });
    service =
        new SqlService(
            new Config(),
            audit,
            new DataSources() {
              public List<Map<String, Object>> list() {
                return Collections.emptyList();
              }

              public DataSource resolve(String id) {
                return "slow".equals(id) ? blocked : source;
              }
            });
  }

  private String open(String owner) throws Exception {
    return String.valueOf(service.open(owner, owner, "test", false).get("id"));
  }

  private Map<String, Object> run(String owner, String id, String sql, String request)
      throws Exception {
    service.execute(
        owner, id, Json.map("sql", sql, "requestId", request, "rowLimit", 1000, "previewRows", 10));
    long until = System.currentTimeMillis() + 5000;
    while (System.currentTimeMillis() < until) {
      Map<String, Object> status = service.status(owner, id);
      @SuppressWarnings("unchecked")
      Map<String, Object> job = (Map<String, Object>) status.get("job");
      if (!java.util.Arrays.asList("RUNNING", "QUEUED").contains(job.get("state"))) return status;
      Thread.sleep(10);
    }
    fail("SQL job did not complete");
    return null;
  }

  private long count() throws Exception {
    try (Connection connection = source.getConnection();
        ResultSet rows = connection.createStatement().executeQuery("SELECT COUNT(*) FROM sample")) {
      rows.next();
      return rows.getLong(1);
    }
  }

  @Test
  void completionWaitsForAuditAndConnectionRelease() throws Exception {
    String id = open("alice");
    synchronized (audit) {
      service.execute("alice", id, Json.map("sql", "SELECT 1", "requestId", "completion001"));
      long deadline = System.currentTimeMillis() + 5000;
      boolean statementFinished = false;
      while (System.currentTimeMillis() < deadline) {
        @SuppressWarnings("unchecked")
        Map<String, Object> job = (Map<String, Object>) service.status("alice", id).get("job");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> steps = (List<Map<String, Object>>) job.get("steps");
        if (!steps.isEmpty() && "DONE".equals(steps.get(0).get("state"))) {
          assertEquals("RUNNING", job.get("state"));
          statementFinished = true;
          break;
        }
        Thread.sleep(1);
      }
      assertTrue(statementFinished, "Statement should finish while audit is held");
    }
    long deadline = System.currentTimeMillis() + 5000;
    while (System.currentTimeMillis() < deadline) {
      @SuppressWarnings("unchecked")
      Map<String, Object> job = (Map<String, Object>) service.status("alice", id).get("job");
      if ("DONE".equals(job.get("state"))) {
        service.control("alice", id, "rollback", Json.map());
        return;
      }
      Thread.sleep(1);
    }
    fail("Completion was not published");
  }

  @Test
  void explicitTransactionsSpanCallsAndStayIsolated() throws Exception {
    String first = open("alice"), second = open("bob");
    assertEquals(false, service.status("alice", first).get("autoCommit"));
    run("alice", first, "INSERT INTO sample VALUES (1, 'a;b');", "request001");
    assertEquals(0, count());
    assertThrows(IllegalArgumentException.class, () -> service.status("bob", first));
    assertEquals(false, service.status("bob", second).get("transactionOpen"));
    service.control("alice", first, "commit", Json.map());
    assertEquals(1, count());
    run("alice", first, "UPDATE sample SET text='changed';", "request002");
    service.control("alice", first, "rollback", Json.map());
    try (Connection connection = source.getConnection();
        ResultSet rows = connection.createStatement().executeQuery("SELECT text FROM sample")) {
      rows.next();
      assertEquals("a;b", rows.getString(1));
    }
  }

  @Test
  void closingOwnerRollsBack() throws Exception {
    String id = open("alice");
    run("alice", id, "INSERT INTO sample VALUES(1,'x')", "request003");
    service.closeOwner("alice");
    assertEquals(0, count());
    assertThrows(IllegalArgumentException.class, () -> service.status("alice", id));
  }

  @Test
  void autocommitCannotSilentlyCommitOpenTransaction() throws Exception {
    String id = open("alice");
    run("alice", id, "INSERT INTO sample VALUES(1,'x')", "request004");
    assertThrows(
        IllegalStateException.class,
        () -> service.control("alice", id, "autocommit", Json.map("enabled", true)));
    assertEquals(0, count());
  }

  @Test
  void retriedRequestDoesNotRepeatWrite() throws Exception {
    String id = open("alice");
    run("alice", id, "INSERT INTO sample VALUES(1,'x')", "request005");
    service.execute(
        "alice",
        id,
        Json.map("sql", "INSERT INTO sample VALUES(1,'x')", "requestId", "request005"));
    service.control("alice", id, "commit", Json.map());
    assertEquals(1, count());
    run("alice", id, "SELECT 1", "request006");
    assertThrows(
        IllegalStateException.class,
        () ->
            service.execute(
                "alice",
                id,
                Json.map("sql", "INSERT INTO sample VALUES(1,'x')", "requestId", "request005")));
  }

  @Test
  void errorStopsScriptAndRequiresRollback() throws Exception {
    String id = open("alice");
    Map<String, Object> status =
        run(
            "alice",
            id,
            "INSERT INTO sample VALUES(1,'x'); SELECT * FROM missing_table; INSERT INTO sample VALUES(2,'y');",
            "request007");
    assertEquals(true, status.get("requiresRollback"));
    service.control("alice", id, "rollback", Json.map());
    assertEquals(0, count());
  }

  @Test
  void csvUsesStoredRowsAndPreservesNullAndSeparators() throws Exception {
    String id = open("alice");
    Map<String, Object> status =
        run(
            "alice",
            id,
            "SELECT 'a;b' AS sample_value, CAST(NULL AS VARCHAR) AS empty_value",
            "request008");
    @SuppressWarnings("unchecked")
    Map<String, Object> job = (Map<String, Object>) status.get("job");
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> steps = (List<Map<String, Object>>) job.get("steps");
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> results = (List<Map<String, Object>>) steps.get(0).get("results");
    @SuppressWarnings("unchecked")
    Map<String, Object> result = (Map<String, Object>) results.get(0).get("result");
    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    service.export(
        "alice",
        id,
        String.valueOf(result.get("id")),
        bytes,
        Json.map("bom", false, "null", "NULL", "separator", ";"));
    assertTrue(bytes.toString("UTF-8").contains("\"a;b\";\"NULL\""));
  }

  @Test
  void readOnlyRoleCannotTrustDriverHintAlone() {
    assertThrows(SecurityException.class, () -> service.open("reader", "reader", "test", true));
  }

  @Test
  @SuppressWarnings("unchecked")
  void currentSchemaIsPreselectedAndFilteringDoesNotSwitchConnection() throws Exception {
    String id = open("alice");
    Map<String, Object> initial = service.metadata("alice", id, null, null);
    assertEquals("PUBLIC", initial.get("currentSchema"));
    assertEquals("PUBLIC", initial.get("selectedSchema"));
    assertTrue(
        ((List<Map<String, Object>>) initial.get("tables"))
            .stream().anyMatch(row -> "SAMPLE".equals(row.get("TABLE_NAME"))));
    Map<String, Object> filtered = service.metadata("alice", id, "INFORMATION_SCHEMA", null);
    assertEquals("PUBLIC", filtered.get("currentSchema"));
    assertEquals("INFORMATION_SCHEMA", filtered.get("selectedSchema"));
    assertEquals("PUBLIC", service.metadata("alice", id, null, null).get("currentSchema"));
    assertEquals(false, service.status("alice", id).get("transactionOpen"));
  }

  @Test
  @SuppressWarnings("unchecked")
  void completionReadsOnlyColumnsForTheExactTableWithoutChangingSchema() throws Exception {
    try (Connection connection = source.getConnection()) {
      connection.createStatement().execute("CREATE TABLE EXACT_A (ONE INT)");
      connection.createStatement().execute("CREATE TABLE EXACTXA (OTHER INT)");
    }
    String id = open("alice");
    Map<String, Object> result = service.metadata("alice", id, "PUBLIC", "EXACT_A", true);
    List<Map<String, Object>> columns = (List<Map<String, Object>>) result.get("columns");
    assertEquals(1, columns.size());
    assertEquals("ONE", columns.get(0).get("COLUMN_NAME"));
    assertFalse(result.containsKey("indexes"));
    assertFalse(result.containsKey("primaryKeys"));
    assertFalse(result.containsKey("foreignKeys"));
    assertEquals("PUBLIC", result.get("currentSchema"));
    assertEquals(false, service.status("alice", id).get("transactionOpen"));
  }

  @Test
  @SuppressWarnings("unchecked")
  void metadataTreatsSqlLikeIdentifiersAsNamesRatherThanQueries() throws Exception {
    String table = "T'; DROP TABLE SAMPLE; --";
    try (Connection connection = source.getConnection()) {
      connection
          .createStatement()
          .execute("CREATE TABLE \"" + table + "\" (\"odd%\" INT PRIMARY KEY)");
    }
    String id = open("alice");
    Map<String, Object> result = service.metadata("alice", id, "PUBLIC", table, false);
    List<Map<String, Object>> columns = (List<Map<String, Object>>) result.get("columns");
    assertEquals(1, columns.size());
    assertEquals("odd%", columns.get(0).get("COLUMN_NAME"));
    assertEquals(1, ((List<Map<String, Object>>) result.get("primaryKeys")).size());
    Map<String, Object> forged =
        service.metadata("alice", id, "PUBLIC", "SAMPLE'; DROP TABLE SAMPLE;--", true);
    assertTrue(((List<Map<String, Object>>) forged.get("columns")).isEmpty());
    assertEquals(0, count());
  }

  @Test
  @SuppressWarnings("unchecked")
  void configuredSchemaTakesPrecedenceOverUserAndEscapesWildcards() throws Exception {
    try (Connection connection = source.getConnection()) {
      connection.createStatement().execute("CREATE SCHEMA APP_ONE");
      connection.createStatement().execute("CREATE SCHEMA APPXONE");
      connection.createStatement().execute("CREATE TABLE APP_ONE.OWN_TABLE(ID INT)");
      connection.createStatement().execute("CREATE TABLE APPXONE.OTHER_TABLE(ID INT)");
    }
    source.setURL(source.getURL() + ";INIT=SET SCHEMA APP_ONE");
    String id = open("alice");
    Map<String, Object> metadata = service.metadata("alice", id, null, null);
    assertEquals("APP_ONE", metadata.get("selectedSchema"));
    List<Map<String, Object>> tables = (List<Map<String, Object>>) metadata.get("tables");
    assertEquals(1, tables.size());
    assertEquals("OWN_TABLE", tables.get(0).get("TABLE_NAME"));
    service.control("alice", id, "schema", Json.map("schema", "PUBLIC"));
    assertEquals("PUBLIC", service.metadata("alice", id, null, null).get("selectedSchema"));
  }

  @Test
  void sparsePagingPreservesUtf8ByteOffsets() throws Exception {
    String id = open("alice");
    Map<String, Object> status =
        run("alice", id, "SELECT X, 'ä;雪' AS unicode_text FROM SYSTEM_RANGE(1,600)", "request009");
    @SuppressWarnings("unchecked")
    Map<String, Object> job = (Map<String, Object>) status.get("job");
    @SuppressWarnings("unchecked")
    Map<String, Object> step = ((List<Map<String, Object>>) job.get("steps")).get(0);
    @SuppressWarnings("unchecked")
    Map<String, Object> result =
        (Map<String, Object>)
            ((List<Map<String, Object>>) step.get("results")).get(0).get("result");
    Map<String, Object> page = service.page("alice", id, String.valueOf(result.get("id")), 513, 10);
    @SuppressWarnings("unchecked")
    List<List<String>> rows = (List<List<String>>) page.get("rows");
    assertEquals("514", rows.get(0).get(0));
    assertEquals("ä;雪", rows.get(0).get(1));
    assertEquals(10, rows.size());
  }
}
