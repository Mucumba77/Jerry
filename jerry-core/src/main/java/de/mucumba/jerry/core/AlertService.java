package de.mucumba.jerry.core;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;
import java.util.function.LongSupplier;

/** Local threshold evaluation. Missing observations never clear an existing warning. */
public final class AlertService {
  private final Path file;
  private final LongSupplier nanos, millis;
  private Map<String, Object> settings;
  private final Map<String, Entry> entries = new LinkedHashMap<>();

  private static final class Entry {
    String kind, source;
    double value;
    boolean active, known;
    long above = -1, below = -1, since;
  }

  public AlertService(Config config) throws IOException {
    this(config, System::nanoTime, System::currentTimeMillis);
  }

  AlertService(Config config, LongSupplier nanos, LongSupplier millis) throws IOException {
    file = config.dataDirectory.resolve("alert-rules.json");
    this.nanos = nanos;
    this.millis = millis;
    settings = defaults();
    if (Files.exists(file)) {
      if (Files.size(file) > 16384)
        throw new IOException("Warnregeln überschreiten das Dateilimit.");
      Map<String, Object> loaded =
          Json.MAPPER.readValue(
              Files.readAllBytes(file), new TypeReference<Map<String, Object>>() {});
      settings = validate(loaded);
    }
  }

  private static Map<String, Object> defaults() {
    return Json.map(
        "enabled",
        true,
        "heapEnabled",
        true,
        "poolEnabled",
        true,
        "errorEnabled",
        true,
        "heapPercent",
        85,
        "poolPercent",
        85,
        "errorPercent",
        5,
        "minRequests",
        20,
        "delaySeconds",
        60,
        "recoverySeconds",
        30,
        "hysteresisPercent",
        5);
  }

  private static Map<String, Object> validate(Map<String, Object> input) {
    Map<String, Object> result = defaults();
    for (String k : Arrays.asList("enabled", "heapEnabled", "poolEnabled", "errorEnabled")) {
      if (!(input.get(k) instanceof Boolean))
        throw new IllegalArgumentException("Ungültige Warnregel: " + k);
      result.put(k, input.get(k));
    }
    for (String k :
        Arrays.asList(
            "heapPercent",
            "poolPercent",
            "errorPercent",
            "minRequests",
            "delaySeconds",
            "recoverySeconds",
            "hysteresisPercent")) {
      Object v = input.get(k);
      int min =
          (k.equals("delaySeconds") || k.equals("recoverySeconds") || k.equals("hysteresisPercent"))
              ? 0
              : 1;
      int max = k.equals("minRequests") ? 100000 : k.endsWith("Seconds") ? 3600 : 100;
      if (!(v instanceof Number)
          || ((Number) v).doubleValue() != ((Number) v).intValue()
          || ((Number) v).intValue() < min
          || ((Number) v).intValue() > max)
        throw new IllegalArgumentException(
            "Ungültiger Wert für " + k + " (" + min + "–" + max + ").");
      result.put(k, ((Number) v).intValue());
    }
    return result;
  }

  public synchronized void configure(Map<String, Object> input) throws IOException {
    Map<String, Object> next = validate(input);
    Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
    Files.write(temporary, Json.MAPPER.writeValueAsBytes(next));
    try {
      Files.move(
          temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (AtomicMoveNotSupportedException exception) {
      Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
    }
    settings = next;
    entries.clear();
  }

  private int number(String key) {
    return ((Number) settings.get(key)).intValue();
  }

  private boolean enabled(String key) {
    return Boolean.TRUE.equals(settings.get("enabled")) && Boolean.TRUE.equals(settings.get(key));
  }

  private static Double num(Object value) {
    return value instanceof Number && Double.isFinite(((Number) value).doubleValue())
        ? ((Number) value).doubleValue()
        : null;
  }

  @SuppressWarnings("unchecked")
  public synchronized void evaluate(Map<String, Object> data) {
    for (Entry e : entries.values()) e.known = false;
    if (!Boolean.TRUE.equals(settings.get("enabled"))) {
      entries.clear();
      return;
    }
    Map<String, Object> heap =
        data.get("heap") instanceof Map
            ? (Map<String, Object>) data.get("heap")
            : Collections.emptyMap();
    Double used = num(heap.get("used")), max = num(heap.get("max"));
    if (enabled("heapEnabled") && used != null && max != null && max > 0)
      observe("heap", "Heap", null, 100 * used / max, number("heapPercent"));
    if (enabled("poolEnabled") && data.get("poolMetrics") instanceof List) {
      Set<String> seen = new HashSet<>();
      for (Object item : (List<?>) data.get("poolMetrics"))
        if (item instanceof Map) {
          Map<String, Object> p = (Map<String, Object>) item;
          Double active = num(p.get("active")), maximum = num(p.get("max"));
          String identity = String.valueOf(p.get("poolId"));
          if (active != null
              && active >= 0
              && maximum != null
              && maximum > 0
              && !"null".equals(identity)
              && seen.add(identity))
            observe(
                "pool:" + identity,
                "Connection Pool",
                p.get("name") == null ? "Datenquelle" : String.valueOf(p.get("name")),
                100 * active / maximum,
                number("poolPercent"));
        }
    }
    if (enabled("errorEnabled") && data.get("connectors") instanceof List) {
      double requests = 0, errors = 0;
      boolean known = true;
      List<?> connectors = (List<?>) data.get("connectors");
      for (Object item : connectors) {
        if (!(item instanceof Map)) {
          known = false;
          break;
        }
        Map<String, Object> c = (Map<String, Object>) item;
        Double r = num(c.get("requestCountRate")), e = num(c.get("errorCountRate"));
        if (r == null || e == null) {
          known = false;
          break;
        }
        requests += r;
        errors += e;
      }
      Double seconds = num(data.get("sampleSeconds"));
      if (known
          && !connectors.isEmpty()
          && seconds != null
          && requests * seconds >= number("minRequests")
          && requests > 0)
        observe("errors", "HTTP-Fehlerrate", null, 100 * errors / requests, number("errorPercent"));
    }
    // A missing sample interrupts debounce timers but must not clear a live alert.
    for (Entry e : entries.values())
      if (!e.known) {
        e.above = -1;
        e.below = -1;
      }
    entries.entrySet().removeIf(item -> !item.getValue().known && !item.getValue().active);
  }

  private void observe(String id, String kind, String source, double value, int threshold) {
    Entry e = entries.computeIfAbsent(id, ignored -> new Entry());
    e.kind = kind;
    e.source = source;
    e.value = value;
    e.known = true;
    long now = nanos.getAsLong();
    if (value >= threshold) {
      e.below = -1;
      if (e.above < 0) e.above = now;
      if (!e.active && now - e.above >= number("delaySeconds") * 1000000000L) {
        e.active = true;
        e.since = millis.getAsLong();
      }
    } else if (value <= Math.max(0, threshold - number("hysteresisPercent"))) {
      e.above = -1;
      if (e.below < 0) e.below = now;
      if (e.active && now - e.below >= number("recoverySeconds") * 1000000000L) {
        e.active = false;
        e.since = 0;
      }
    } else {
      e.above = -1;
      e.below = -1;
    }
  }

  public synchronized Map<String, Object> snapshot() {
    List<Map<String, Object>> active = new ArrayList<>();
    int pending = 0;
    for (Entry e : entries.values()) {
      if (e.active)
        active.add(
            Json.map(
                "kind", e.kind, "source", e.source, "value", e.value, "known", e.known, "since",
                e.since));
      else if (e.known && e.above >= 0) pending++;
    }
    return Json.map(
        "settings", new LinkedHashMap<>(settings), "active", active, "pending", pending);
  }
}
