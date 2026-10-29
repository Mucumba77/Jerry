package de.mucumba.jerry.core;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/** Persists bounded-resolution local monitoring samples and serves time-window queries. */
public final class MetricStore {
  private final Config config;
  private final Path directory;
  private long minute = -1, lastCleanup;
  private final List<Map<String, Object>> bucket = new ArrayList<>();

  public MetricStore(Config config) throws IOException {
    this.config = config;
    directory = config.dataDirectory.resolve("metrics");
    Files.createDirectories(directory);
    prune();
  }

  /** Persists a sample and maintains the lower-resolution minute archive. */
  public synchronized void append(Map<String, Object> data) throws IOException {
    long time = ((Number) data.get("time")).longValue();
    String hour =
        DateTimeFormatter.ofPattern("yyyy-MM-dd-HH")
            .withZone(ZoneOffset.UTC)
            .format(Instant.ofEpochMilli(time));
    write(directory.resolve("raw-" + hour + ".jsonl"), data);
    long current = time / 60000;
    if (minute != current && !bucket.isEmpty()) {
      Map<String, Object> summary = new java.util.LinkedHashMap<>(bucket.get(bucket.size() - 1));
      double sum = 0, min = Double.MAX_VALUE, max = 0;
      for (Map<String, Object> sample : bucket) {
        @SuppressWarnings("unchecked")
        Map<String, Object> heap = (Map<String, Object>) sample.get("heap");
        double used = ((Number) heap.get("used")).doubleValue();
        sum += used;
        min = Math.min(min, used);
        max = Math.max(max, used);
      }
      summary.put(
          "aggregation",
          Json.map(
              "samples",
              bucket.size(),
              "heapUsedMin",
              min,
              "heapUsedMax",
              max,
              "heapUsedAverage",
              sum / bucket.size(),
              "resolutionMs",
              60000));
      String day =
          DateTimeFormatter.ISO_LOCAL_DATE
              .withZone(ZoneOffset.UTC)
              .format(Instant.ofEpochMilli(((Number) summary.get("time")).longValue()));
      write(directory.resolve("minute-" + day + ".jsonl"), summary);
      bucket.clear();
    }
    minute = current;
    bucket.add(data);
    if (time - lastCleanup > 60000) {
      prune();
      lastCleanup = time;
    }
  }

  private static void write(Path file, Map<String, Object> data) throws IOException {
    Files.write(
        file,
        (Json.MAPPER.writeValueAsString(data) + "\n").getBytes(StandardCharsets.UTF_8),
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
  }

  /** Returns chronological samples in the requested interval, bounded by the point limit. */
  public List<Map<String, Object>> query(long from, long to, int maxPoints) throws IOException {
    maxPoints = Math.max(2, maxPoints);
    boolean raw =
        from
            >= System.currentTimeMillis()
                - config.number("monitor.raw.hours", 24, 1, 168) * 3600000L;
    List<Path> files;
    try (Stream<Path> paths = Files.list(directory)) {
      files =
          paths
              .filter(path -> path.getFileName().toString().startsWith(raw ? "raw-" : "minute-"))
              .sorted()
              .collect(Collectors.toList());
    }
    List<Map<String, Object>> points = new ArrayList<>();
    Map<String, Object> lastPoint = null;
    long lastBucket = Long.MIN_VALUE;
    long resolution =
        Math.max(
            raw ? config.number("monitor.interval.seconds", 10, 1, 60) * 1000L : 60000L,
            (to - from) / maxPoints);
    long deadline = System.currentTimeMillis() + 15000;
    for (Path file : files) {
      long start;
      try {
        String name = file.getFileName().toString();
        start =
            raw
                ? java.time.LocalDateTime.parse(
                        name.substring(4, 17) + ":00",
                        DateTimeFormatter.ofPattern("yyyy-MM-dd-HH:mm"))
                    .toInstant(ZoneOffset.UTC)
                    .toEpochMilli()
                : java.time.LocalDate.parse(name.substring(7, 17))
                    .atStartOfDay()
                    .toInstant(ZoneOffset.UTC)
                    .toEpochMilli();
      } catch (RuntimeException exception) {
        continue;
      }
      if (start > to || start + (raw ? 3600000L : 86400000L) < from) continue;
      try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
        String line;
        while ((line = reader.readLine()) != null) {
          if (System.currentTimeMillis() > deadline)
            throw new IOException(
                "Historienabfrage überschreitet das Zeitlimit. Zeitraum eingrenzen.");
          Map<String, Object> point;
          try {
            point = Json.MAPPER.readValue(line, new TypeReference<Map<String, Object>>() {});
          } catch (IOException ignored) {
            continue;
          }
          if (!(point.get("time") instanceof Number)) continue;
          long time = ((Number) point.get("time")).longValue();
          if (time < from || time > to) continue;
          lastPoint = point;
          long index = time / resolution;
          if (index != lastBucket) {
            if (points.size() < maxPoints) points.add(point);
            else points.set(maxPoints - 1, point);
            lastBucket = index;
          }
        }
      }
    }
    if (lastPoint != null && !points.isEmpty()) {
      if (points.size() == 1 && !points.get(0).get("time").equals(lastPoint.get("time")))
        points.add(lastPoint);
      else points.set(points.size() - 1, lastPoint);
    }
    return points;
  }

  private void prune() throws IOException {
    long now = System.currentTimeMillis(), bytes = 0;
    List<Path> remaining = new ArrayList<>();
    try (Stream<Path> paths = Files.list(directory)) {
      for (Path file : paths.filter(Files::isRegularFile).collect(Collectors.toList())) {
        boolean raw = file.getFileName().toString().startsWith("raw-");
        long lifetime =
            raw
                ? config.number("monitor.raw.hours", 24, 1, 168) * 3600000L
                : config.number("monitor.history.days", 30, 1, 365) * 86400000L;
        if (now - Files.getLastModifiedTime(file).toMillis() > lifetime) Files.deleteIfExists(file);
        else {
          remaining.add(file);
          bytes += Files.size(file);
        }
      }
    }
    remaining.sort(
        Comparator.comparingLong(
            path -> {
              try {
                return Files.getLastModifiedTime(path).toMillis();
              } catch (IOException ignored) {
                return 0;
              }
            }));
    long limit = config.number("monitor.disk.mb", 256, 16, 4096) * 1024L * 1024;
    for (Path file : remaining)
      if (bytes > limit) {
        bytes -= Files.size(file);
        Files.deleteIfExists(file);
      }
  }
}
