package de.mucumba.jerry.core;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/** Persistent opt-in for aggregation; diagnostic leases are deliberately process-local. */
public final class MonitoringProfiles {
  public enum Mode {
    BASIC,
    EXTENDED,
    DIAGNOSTIC
  }

  private static final class Entry {
    volatile Mode baseline = Mode.BASIC;
    volatile Lease lease;
    volatile long revision;
  }

  private static final class Lease {
    final long deadline, expiresAt;

    Lease(long deadline, long expiresAt) {
      this.deadline = deadline;
      this.expiresAt = expiresAt;
    }
  }

  private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();
  private final AtomicLong revisions = new AtomicLong();
  private final Path file;
  private final LongSupplier nanos, millis;
  private final int maxSeconds, maxDiagnostic;

  public MonitoringProfiles(Config config) throws IOException {
    this(config, System::nanoTime, System::currentTimeMillis);
  }

  MonitoringProfiles(Config config, LongSupplier nanos, LongSupplier millis) throws IOException {
    this.nanos = nanos;
    this.millis = millis;
    maxSeconds = config.number("monitor.diagnostic.maxSeconds", 900, 10, 3600);
    maxDiagnostic = config.number("monitor.diagnostic.maxApplications", 2, 1, 16);
    file = config.dataDirectory.resolve("monitoring-profiles.json");
    if (Files.exists(file)) {
      if (Files.size(file) > 256 * 1024)
        throw new IOException("Monitoring-Profile überschreiten das Dateilimit.");
      List<String> enabled =
          Json.MAPPER.readValue(Files.readAllBytes(file), new TypeReference<List<String>>() {});
      if (enabled.size() > 512) throw new IOException("Zu viele Monitoring-Profile.");
      for (String id : enabled) {
        validate(id);
        Entry entry = new Entry();
        entry.baseline = Mode.EXTENDED;
        entry.revision = revisions.incrementAndGet();
        entries.put(id, entry);
      }
    }
  }

  private static void validate(String id) {
    if (id == null || !id.matches("[A-Za-z0-9_-]{1,1000}"))
      throw new IllegalArgumentException("Ungültige Anwendungs-ID.");
  }

  public Mode mode(String id) {
    Entry entry = entries.get(id);
    if (entry == null) return Mode.BASIC;
    Lease lease = entry.lease;
    return lease != null && nanos.getAsLong() < lease.deadline ? Mode.DIAGNOSTIC : entry.baseline;
  }

  public long revision(String id) {
    Entry entry = entries.get(id);
    return entry == null ? 0 : entry.revision;
  }

  public Map<String, Object> state(String id) {
    Entry entry = entries.get(id);
    Mode mode = mode(id);
    Lease lease = entry == null ? null : entry.lease;
    return Json.map(
        "mode",
        mode.name(),
        "baseline",
        entry == null ? "BASIC" : entry.baseline.name(),
        "expiresAt",
        mode == Mode.DIAGNOSTIC && lease != null ? lease.expiresAt : null,
        "remainingSeconds",
        mode == Mode.DIAGNOSTIC && lease != null
            ? Math.max(0, (lease.deadline - nanos.getAsLong() + 999999999L) / 1000000000L)
            : 0,
        "revision",
        revision(id),
        "maxDiagnosticSeconds",
        maxSeconds,
        "maxDiagnosticApplications",
        maxDiagnostic);
  }

  /**
   * Changes an application profile; diagnostic leases expire using monotonic time and are not
   * persisted.
   */
  public synchronized Map<String, Object> change(String id, String requested, int seconds)
      throws IOException {
    validate(id);
    Mode mode;
    try {
      mode = Mode.valueOf(requested);
    } catch (Exception exception) {
      throw new IllegalArgumentException("Unbekannte Betriebsart.");
    }
    if (entries.size() >= 512 && !entries.containsKey(id))
      throw new IllegalStateException("Maximal 512 Anwendungsprofile.");
    Entry entry = entries.computeIfAbsent(id, ignored -> new Entry());
    if (mode == Mode.DIAGNOSTIC) {
      if (seconds < 10 || seconds > maxSeconds)
        throw new IllegalArgumentException(
            "Diagnosedauer muss zwischen 10 und " + maxSeconds + " Sekunden liegen.");
      long active =
          entries.keySet().stream()
              .filter(key -> !key.equals(id) && mode(key) == Mode.DIAGNOSTIC)
              .count();
      if (active >= maxDiagnostic)
        throw new IllegalStateException("Zu viele gleichzeitige Diagnosen.");
      entry.revision = revisions.incrementAndGet();
      entry.lease =
          new Lease(
              nanos.getAsLong() + seconds * 1000000000L, millis.getAsLong() + seconds * 1000L);
    } else {
      // Persist the new baseline before publishing it. A failed write leaves the old setting
      // active.
      List<String> enabled = new ArrayList<>();
      for (Map.Entry<String, Entry> item : entries.entrySet())
        if (!item.getKey().equals(id) && item.getValue().baseline == Mode.EXTENDED)
          enabled.add(item.getKey());
      if (mode == Mode.EXTENDED) enabled.add(id);
      Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
      Files.write(temporary, Json.MAPPER.writeValueAsBytes(enabled));
      try {
        Files.move(
            temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
      } catch (java.nio.file.AtomicMoveNotSupportedException exception) {
        Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
      }
      entry.revision = revisions.incrementAndGet();
      entry.baseline = mode;
      entry.lease = null;
    }
    return state(id);
  }
  /** End a diagnostic lease and restore the selected baseline. */
  public synchronized Map<String, Object> stop(String id) {
    Entry entry = entries.get(id);
    if (entry != null) {
      entry.revision = revisions.incrementAndGet();
      entry.lease = null;
    }
    return state(id);
  }
}
