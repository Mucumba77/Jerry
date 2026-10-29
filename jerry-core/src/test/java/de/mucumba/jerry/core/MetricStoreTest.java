package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MetricStoreTest {
  @TempDir Path temporary;

  @AfterEach
  void cleanup() {
    System.clearProperty("jerry.data.dir");
    System.clearProperty("jerry.config");
  }

  private MetricStore store() throws Exception {
    System.setProperty("jerry.data.dir", temporary.toString());
    System.setProperty("jerry.config", temporary.resolve("absent.properties").toString());
    return new MetricStore(new Config());
  }

  private void write(long time, String line) throws Exception {
    String hour =
        DateTimeFormatter.ofPattern("yyyy-MM-dd-HH")
            .withZone(ZoneOffset.UTC)
            .format(Instant.ofEpochMilli(time));
    Files.write(
        temporary.resolve("metrics").resolve("raw-" + hour + ".jsonl"),
        (line + "\n").getBytes(StandardCharsets.UTF_8),
        StandardOpenOption.CREATE,
        StandardOpenOption.APPEND);
  }

  @Test
  void boundedHistoryIncludesLatestSampleAndSkipsInvalidRecords() throws Exception {
    MetricStore store = store();
    long from = (System.currentTimeMillis() / 10000) * 10000 - 120000;
    for (int index = 0; index <= 10; index++) {
      long time = from + index * 10000L;
      write(time, Json.MAPPER.writeValueAsString(Json.map("time", time, "value", index)));
      if (index == 4) {
        write(time, "{\"heap\":{}}");
        write(time, "{broken");
      }
    }
    List<Map<String, Object>> points = store.query(from, from + 100000, 10);
    assertEquals(10, points.size());
    assertEquals(from, ((Number) points.get(0).get("time")).longValue());
    assertEquals(from + 100000, ((Number) points.get(points.size() - 1).get("time")).longValue());
  }

  @Test
  void twoSamplesInSameBucketKeepBothEndpoints() throws Exception {
    MetricStore store = store();
    long from = (System.currentTimeMillis() / 10000) * 10000 - 50000;
    write(from + 1, Json.MAPPER.writeValueAsString(Json.map("time", from + 1)));
    write(from + 2, Json.MAPPER.writeValueAsString(Json.map("time", from + 2)));
    List<Map<String, Object>> points = store.query(from, from + 10000, 10);
    assertEquals(2, points.size());
    assertEquals(from + 1, ((Number) points.get(0).get("time")).longValue());
    assertEquals(from + 2, ((Number) points.get(1).get("time")).longValue());
  }
}
