package de.mucumba.jerry.core;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;

/** Manages bounded reads, searches, downloads and leases for approved log files. */
public final class LogService implements AutoCloseable {
  private final Config config;
  private final Audit audit;
  private final List<Path> roots;
  private final Path cache;
  private final ThreadPoolExecutor workers =
      new ThreadPoolExecutor(
          2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<Runnable>(8), new Workers("logs"));
  private final Map<String, Search> searches = new ConcurrentHashMap<>();
  private static final Pattern LEVEL =
      Pattern.compile(
          "\\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|SEVERE|FATAL|FINE(?:ST|R)?|CONFIG|INFORMATION|WARNUNG|SCHWERWIEGEND|FEIN(?:ER)?)\\b");
  private static final Pattern TIMESTAMP =
      Pattern.compile(
          "^(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?)");
  private static final Pattern JULI_TIMESTAMP =
      Pattern.compile("^(\\d{2}-[A-Za-z]{3}-\\d{4} \\d{2}:\\d{2}:\\d{2}\\.\\d{3})");
  private static final Pattern THREAD = Pattern.compile("\\[([^\\]]{1,250})\\]");

  private static final class Search {
    final String id = UUID.randomUUID().toString(), owner;
    final long created = System.currentTimeMillis();
    final AtomicBoolean cancelled = new AtomicBoolean();
    final List<Map<String, Object>> hits = new ArrayList<>();
    volatile String state = "QUEUED", error;
    volatile long scanned, bytes;
    volatile boolean truncated;

    Search(String owner) {
      this.owner = owner;
    }

    synchronized Map<String, Object> data() {
      return Json.map(
          "id",
          id,
          "state",
          state,
          "error",
          error,
          "scannedLines",
          scanned,
          "hits",
          new ArrayList<>(hits),
          "truncated",
          truncated);
    }
  }

  public LogService(Config config, Audit audit) throws IOException {
    this.config = config;
    this.audit = audit;
    roots = config.logDirectories();
    cache = config.dataDirectory.resolve("log-cache");
    Files.createDirectories(cache);
    trimCache(0);
  }

  public List<Map<String, Object>> files() throws IOException {
    List<Map<String, Object>> result = new ArrayList<>();
    for (int index = 0; index < roots.size(); index++) {
      Path root = roots.get(index);
      final int rootIndex = index;
      try (Stream<Path> paths = Files.walk(root, config.number("logs.depth", 4, 1, 10))) {
        java.util.Iterator<Path> iterator = paths.iterator();
        while (iterator.hasNext() && result.size() < 5000) {
          Path path = iterator.next();
          if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) continue;
          if (!path.toRealPath().startsWith(root)) continue;
          BasicFileAttributes attributes = Files.readAttributes(path, BasicFileAttributes.class);
          String relative = root.relativize(path).toString().replace('\\', '/');
          result.add(
              Json.map(
                  "id",
                  encode(rootIndex + ":" + relative),
                  "name",
                  relative,
                  "root",
                  root.toString(),
                  "size",
                  attributes.size(),
                  "modified",
                  attributes.lastModifiedTime().toMillis(),
                  "compressed",
                  relative.toLowerCase(Locale.ROOT).endsWith(".gz")));
        }
      }
    }
    result.sort(
        (a, b) ->
            Long.compare(
                ((Number) b.get("modified")).longValue(),
                ((Number) a.get("modified")).longValue()));
    return result;
  }

  private Path resolve(String id) throws IOException {
    try {
      String decoded = new String(Base64.getUrlDecoder().decode(id), StandardCharsets.UTF_8);
      int colon = decoded.indexOf(':');
      int index = Integer.parseInt(decoded.substring(0, colon));
      if (index < 0 || index >= roots.size())
        throw new SecurityException("Unbekanntes Log-Verzeichnis.");
      Path root = roots.get(index);
      Path candidate = root.resolve(decoded.substring(colon + 1)).normalize();
      if (!candidate.startsWith(root)
          || !candidate.toRealPath().startsWith(root)
          || !Files.isRegularFile(candidate))
        throw new SecurityException("Log-Datei liegt außerhalb der freigegebenen Verzeichnisse.");
      return candidate.toRealPath();
    } catch (IllegalArgumentException | IndexOutOfBoundsException exception) {
      throw new IllegalArgumentException("Ungültige Log-Datei.");
    }
  }

  private static String encode(String text) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(text.getBytes(StandardCharsets.UTF_8));
  }

  private static Charset charset(String name) {
    if (!java.util.Arrays.asList("UTF-8", "ISO-8859-1", "windows-1252", "UTF-16LE", "UTF-16BE")
        .contains(name)) throw new IllegalArgumentException("Nicht unterstützter Zeichensatz.");
    return Charset.forName(name);
  }

  private synchronized Path readable(Path source) throws IOException {
    if (!source.toString().toLowerCase(Locale.ROOT).endsWith(".gz")) return source;
    long max = config.number("logs.archive.mb", 256, 1, 2048) * 1024L * 1024;
    String signature =
        Audit.fingerprint(
            source + ":" + Files.size(source) + ":" + Files.getLastModifiedTime(source).toMillis());
    Path extracted = cache.resolve(signature + ".log");
    if (Files.exists(extracted)) {
      Files.setLastModifiedTime(
          extracted, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis()));
      return extracted;
    }
    trimCache(max);
    Path temporary = cache.resolve(signature + ".part");
    long count = 0;
    try (InputStream input = new GZIPInputStream(Files.newInputStream(source));
        OutputStream output = Files.newOutputStream(temporary)) {
      byte[] buffer = new byte[65536];
      int read;
      while ((read = input.read(buffer)) != -1) {
        count += read;
        if (count > max)
          throw new IOException(
              "Archiv überschreitet das Entpacklimit. Direkten Download oder archivübergreifende Suche verwenden.");
        output.write(buffer, 0, read);
      }
    } catch (IOException exception) {
      Files.deleteIfExists(temporary);
      throw exception;
    }
    Files.move(temporary, extracted, StandardCopyOption.REPLACE_EXISTING);
    return extracted;
  }

  private void trimCache(long reserve) throws IOException {
    long limit = config.number("logs.cache.mb", 512, 16, 4096) * 1024L * 1024;
    List<Path> files;
    try (Stream<Path> stream = Files.list(cache)) {
      files =
          stream
              .filter(Files::isRegularFile)
              .sorted(
                  Comparator.comparingLong(
                      path -> {
                        try {
                          return Files.getLastModifiedTime(path).toMillis();
                        } catch (IOException ignored) {
                          return 0L;
                        }
                      }))
              .collect(Collectors.toList());
    }
    long total = 0;
    for (Path path : files) total += Files.size(path);
    for (Path path : files)
      if (total + reserve > limit || path.toString().endsWith(".part")) {
        long bytes = Files.size(path);
        try {
          Files.deleteIfExists(path);
          total -= bytes;
        } catch (IOException ignored) {
        }
      }
    if (total + reserve > limit)
      throw new IOException(
          "Der Log-Cache ist belegt. Später erneut versuchen oder das Cachelimit erhöhen.");
  }

  public Map<String, Object> read(
      String id, long cursor, int limit, String encoding, String identity, String direction)
      throws IOException {
    Path source = resolve(id), file = readable(source);
    Charset charset = charset(encoding);
    long length = Files.size(file);
    BasicFileAttributes attrs = Files.readAttributes(file, BasicFileAttributes.class);
    String currentIdentity =
        Audit.fingerprint(
            file + ":" + attrs.creationTime().toMillis() + ":" + String.valueOf(attrs.fileKey()));
    boolean rotated =
        cursor > length
            || (identity != null && !identity.isEmpty() && !identity.equals(currentIdentity));
    if (cursor > length || rotated) cursor = 0;
    long start = Math.max(0, cursor);
    int maximumBytes = config.number("logs.page.kb", 512, 32, 2048) * 1024;
    if (cursor < 0) start = Math.max(0, length - maximumBytes);
    if ("previous".equals(direction)) start = Math.max(0, cursor - maximumBytes);
    List<Map<String, Object>> lines = new ArrayList<>();
    try (RandomAccessFile reader = new RandomAccessFile(file.toFile(), "r")) {
      reader.seek(start);
      boolean utf16 = encoding.startsWith("UTF-16");
      if (utf16 && (start & 1) == 1) {
        start++;
        reader.seek(start);
      }
      long end = "previous".equals(direction) ? cursor : length;
      int bytesRead = 0;
      boolean boundary = start == 0;
      if (start > 0) {
        if (utf16 && start >= 2) {
          reader.seek(start - 2);
          int a = reader.read(), b = reader.read();
          boundary =
              ("UTF-16LE".equals(encoding) ? a : b) == 10
                  && ("UTF-16LE".equals(encoding) ? b : a) == 0;
        } else if (!utf16) {
          reader.seek(start - 1);
          boundary = reader.read() == 10;
        }
        reader.seek(start);
      }
      if (!boundary) {
        if (utf16) {
          while (reader.getFilePointer() + 1 < length) {
            if (reader.getFilePointer() - start > maximumBytes)
              throw new IOException(
                  "Eine Log-Zeile überschreitet das Lesefenster. Die Suche oder den Originaldownload verwenden.");
            int a = reader.read(), b = reader.read();
            if (("UTF-16LE".equals(encoding) ? a : b) == 10
                && ("UTF-16LE".equals(encoding) ? b : a) == 0) break;
          }
        } else {
          while (reader.getFilePointer() < length && reader.read() != 10) {
            if (reader.getFilePointer() - start > maximumBytes)
              throw new IOException(
                  "Eine Log-Zeile überschreitet das Lesefenster. Die Suche oder den Originaldownload verwenden.");
          }
        }
        start = reader.getFilePointer();
      }
      while (reader.getFilePointer() < end && bytesRead < maximumBytes) {
        long position = reader.getFilePointer();
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        boolean truncated = false;
        while (reader.getFilePointer() < length) {
          int a = reader.read();
          if (a < 0) break;
          bytesRead++;
          if (utf16) {
            int b = reader.read();
            if (b < 0) break;
            bytesRead++;
            if (("UTF-16LE".equals(encoding) ? a : b) == 10
                && ("UTF-16LE".equals(encoding) ? b : a) == 0) break;
            if (line.size() < 65536) {
              line.write(a);
              line.write(b);
            } else truncated = true;
          } else {
            if (a == 10) break;
            if (line.size() < 65536) line.write(a);
            else truncated = true;
          }
          if (bytesRead > maximumBytes + 1048576) {
            truncated = true;
            break;
          }
        }
        String text = new String(line.toByteArray(), charset).replaceAll("\\r$", "");
        Map<String, Object> row = event(text);
        row.put("offset", position);
        row.put("text", text);
        row.put("truncated", truncated);
        lines.add(row);
        if (cursor >= 0 && !"previous".equals(direction) && lines.size() >= limit) break;
      }
      long next = reader.getFilePointer();
      if (cursor < 0 || "previous".equals(direction)) {
        if (lines.size() > limit) {
          lines = new ArrayList<>(lines.subList(lines.size() - limit, lines.size()));
          start = ((Number) lines.get(0).get("offset")).longValue();
        }
      }
      return Json.map(
          "id",
          id,
          "identity",
          currentIdentity,
          "start",
          start,
          "next",
          next,
          "size",
          length,
          "eof",
          next >= length,
          "rotated",
          rotated,
          "lines",
          lines);
    }
  }

  public String filename(String id) throws IOException {
    return resolve(id).getFileName().toString();
  }

  public void download(String user, String id, OutputStream output) throws IOException {
    Path path = resolve(id);
    Files.copy(path, output);
    audit.event(user, "logs.download", path.getFileName().toString(), "OK");
  }

  public String startSearch(String owner, String user, Map<String, Object> input)
      throws IOException {
    reap();
    int owned = 0;
    for (Search search : searches.values()) if (search.owner.equals(owner)) owned++;
    if (owned >= 4 || searches.size() >= 24)
      throw new IllegalStateException(
          "Zu viele Log-Suchaufträge. Alte Suche schließen oder kurz warten.");
    Object ids = input.get("files");
    if (!(ids instanceof List)) throw new IllegalArgumentException("Dateien fehlen.");
    List<Path> paths = new ArrayList<>();
    List<String> names = new ArrayList<>();
    for (Object id : (List<?>) ids) {
      if (paths.size() >= 50) throw new IllegalArgumentException("Maximal 50 Dateien pro Suche.");
      paths.add(resolve(String.valueOf(id)));
      names.add(String.valueOf(id));
    }
    if (paths.isEmpty()) throw new IllegalArgumentException("Mindestens eine Datei auswählen.");
    Search search = new Search(owner);
    searches.put(search.id, search);
    try {
      workers.execute(() -> search(search, paths, names, input));
    } catch (java.util.concurrent.RejectedExecutionException exception) {
      searches.remove(search.id);
      throw new IllegalStateException("Suchwarteschlange ist voll.");
    }
    audit.event(user, "logs.search", "files:" + paths.size(), "QUEUED");
    return search.id;
  }

  private void search(
      Search search, List<Path> files, List<String> ids, Map<String, Object> input) {
    search.state = "RUNNING";
    long deadline =
        System.currentTimeMillis() + config.number("logs.search.seconds", 60, 1, 300) * 1000L;
    String query = Json.text(input, "query", "");
    boolean sensitive = Boolean.parseBoolean(Json.text(input, "caseSensitive", "false"));
    if (!sensitive) query = query.toLowerCase(Locale.ROOT);
    String level = Json.text(input, "level", "");
    String thread = Json.text(input, "thread", ""), logger = Json.text(input, "logger", "");
    long from = parseLong(Json.text(input, "from", "0")),
        to = parseLong(Json.text(input, "to", "0"));
    int context = Json.integer(input, "context", 2, 0, 10),
        max = Json.integer(input, "maxHits", 1000, 1, 5000);
    long byteLimit = config.number("logs.search.output.mb", 8, 1, 64) * 1024L * 1024;
    try {
      for (int i = 0; i < files.size(); i++) {
        Path file = files.get(i);
        Deque<String> before = new ArrayDeque<>();
        long number = 0;
        long eventTime = 0;
        String eventLevel = "", eventThread = "", eventLogger = "";
        int after = 0;
        try (InputStream raw = new BufferedInputStream(Files.newInputStream(file));
            InputStream decoded =
                file.toString().toLowerCase(Locale.ROOT).endsWith(".gz")
                    ? new GZIPInputStream(raw)
                    : raw;
            BufferedReader reader =
                new BufferedReader(
                    new InputStreamReader(
                        decoded, charset(Json.text(input, "encoding", "UTF-8"))))) {
          String text;
          while ((text = boundedLine(reader, search, deadline)) != null) {
            number++;
            search.scanned++;
            if (search.cancelled.get() || System.currentTimeMillis() > deadline) {
              search.truncated = true;
              break;
            }
            Map<String, Object> parsed = event(text);
            if (parsed.get("time") != null) eventTime = ((Number) parsed.get("time")).longValue();
            if (parsed.get("level") != null) eventLevel = String.valueOf(parsed.get("level"));
            if (parsed.get("thread") != null) eventThread = String.valueOf(parsed.get("thread"));
            if (parsed.get("logger") != null) eventLogger = String.valueOf(parsed.get("logger"));
            boolean matches =
                (sensitive ? text : text.toLowerCase(Locale.ROOT)).contains(query)
                    && (level.isEmpty() || eventLevel.equals(level))
                    && (from == 0 || eventTime >= from)
                    && (to == 0 || (eventTime != 0 && eventTime <= to))
                    && (thread.isEmpty() || eventThread.contains(thread))
                    && (logger.isEmpty() || eventLogger.contains(logger));
            if (matches || after > 0) {
              if (matches) after = context;
              else after--;
              Map<String, Object> hit =
                  Json.map(
                      "file",
                      ids.get(i),
                      "name",
                      file.getFileName().toString(),
                      "line",
                      number,
                      "text",
                      text,
                      "level",
                      eventLevel,
                      "time",
                      eventTime == 0 ? null : eventTime,
                      "match",
                      matches,
                      "before",
                      matches ? new ArrayList<>(before) : java.util.Collections.emptyList());
              synchronized (search) {
                search.hits.add(hit);
                search.bytes += text.length() * 2L + before.toString().length() * 2L;
              }
              if (search.hits.size() >= max || search.bytes >= byteLimit) {
                search.truncated = true;
                break;
              }
            }
            before.addLast(text);
            while (before.size() > context) before.removeFirst();
          }
        }
        if (search.truncated) break;
      }
      search.state = search.cancelled.get() ? "CANCELLED" : "DONE";
    } catch (Exception exception) {
      search.state = "ERROR";
      search.error = exception.getMessage();
    }
  }

  private static String boundedLine(BufferedReader reader, Search search, long deadline)
      throws IOException {
    StringBuilder out = new StringBuilder();
    int c, count = 0;
    boolean found = false;
    while ((c = reader.read()) != -1) {
      found = true;
      if ((++count & 8191) == 0
          && (search.cancelled.get()
              || System.currentTimeMillis() > deadline
              || Thread.currentThread().isInterrupted())) {
        search.truncated = true;
        return null;
      }
      if (c == '\n') break;
      if (out.length() < 65536 && c != '\r') out.append((char) c);
    }
    return found ? out.toString() : null;
  }

  public Map<String, Object> searchStatus(String owner, String id) {
    return own(owner, id).data();
  }

  public void cancelSearch(String owner, String id) {
    own(owner, id).cancelled.set(true);
  }

  public void removeSearch(String owner, String id) {
    Search search = own(owner, id);
    search.cancelled.set(true);
    searches.remove(id, search);
  }

  private Search own(String owner, String id) {
    Search search = searches.get(id);
    if (search == null || !search.owner.equals(owner))
      throw new IllegalArgumentException("Suchauftrag ist abgelaufen.");
    return search;
  }

  public void closeOwner(String owner) {
    for (Search search : searches.values())
      if (search.owner.equals(owner)) {
        search.cancelled.set(true);
        searches.remove(search.id);
      }
  }

  public void reap() {
    long now = System.currentTimeMillis();
    for (Search search : searches.values())
      if (now - search.created > 600000) {
        search.cancelled.set(true);
        searches.remove(search.id);
      }
  }

  private Map<String, Object> event(String text) {
    Map<String, Object> row = Json.map();
    Matcher level = LEVEL.matcher(text);
    row.put("level", level.find() ? normalizeLevel(level.group(1)) : null);
    Matcher match = TIMESTAMP.matcher(text);
    Long time = null;
    if (match.find()) {
      String stamp = match.group(1).replace(' ', 'T').replace(',', '.');
      try {
        time = java.time.OffsetDateTime.parse(stamp).toInstant().toEpochMilli();
      } catch (DateTimeParseException ignored) {
        try {
          time =
              LocalDateTime.parse(stamp, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                  .atZone(ZoneId.of(config.get("logs.timezone", ZoneId.systemDefault().getId())))
                  .toInstant()
                  .toEpochMilli();
        } catch (DateTimeParseException ignoredAgain) {
        }
      }
    }
    if (time == null) {
      Matcher juli = JULI_TIMESTAMP.matcher(text);
      try {
        ZoneId zone = ZoneId.of(config.get("logs.timezone", ZoneId.systemDefault().getId()));
        if (juli.find())
          time =
              LocalDateTime.parse(
                      juli.group(1),
                      DateTimeFormatter.ofPattern("dd-MMM-yyyy HH:mm:ss.SSS", Locale.ENGLISH))
                  .atZone(zone)
                  .toInstant()
                  .toEpochMilli();
        String custom = config.get("logs.timestamp.pattern", "");
        if (!custom.isEmpty()) {
          Matcher customMatch =
              Pattern.compile(config.get("logs.timestamp.regex", "^(.{23})")).matcher(text);
          if (customMatch.find())
            time =
                LocalDateTime.parse(
                        customMatch.group(1),
                        DateTimeFormatter.ofPattern(
                            custom,
                            Locale.forLanguageTag(config.get("logs.timestamp.locale", "en"))))
                    .atZone(zone)
                    .toInstant()
                    .toEpochMilli();
        }
      } catch (RuntimeException ignored) {
      }
    }
    Matcher thread = THREAD.matcher(text);
    String threadName = thread.find() ? thread.group(1) : null;
    String loggerName = null;
    if (threadName != null) {
      String after = text.substring(thread.end()).trim();
      Matcher logger =
          Pattern.compile("^([A-Za-z_$][A-Za-z0-9_.$]*(?:\\.[A-Za-z0-9_$]+)+)").matcher(after);
      if (logger.find()) loggerName = logger.group(1);
    }
    row.put("time", time);
    row.put("thread", threadName);
    row.put("logger", loggerName);
    return row;
  }

  private static String normalizeLevel(String level) {
    if ("WARNING".equals(level) || "WARNUNG".equals(level)) return "WARN";
    if ("SEVERE".equals(level) || "SCHWERWIEGEND".equals(level)) return "ERROR";
    if ("INFORMATION".equals(level)) return "INFO";
    if ("FINE".equals(level) || "FEIN".equals(level)) return "DEBUG";
    if (level.startsWith("FIN") || level.startsWith("FEIN")) return "TRACE";
    return level;
  }

  private static long parseLong(String text) {
    try {
      return Long.parseLong(text);
    } catch (NumberFormatException ignored) {
      return 0;
    }
  }

  @Override
  public void close() {
    for (Search search : searches.values()) search.cancelled.set(true);
    workers.shutdownNow();
  }
}
