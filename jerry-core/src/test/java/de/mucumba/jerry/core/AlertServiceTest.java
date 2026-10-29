package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;

class AlertServiceTest {
  @TempDir Path directory;
  private final AtomicLong clock = new AtomicLong();

  private Config config() throws Exception {
    System.setProperty("jerry.data.dir", directory.toString());
    System.setProperty("jerry.config", directory.resolve("absent").toString());
    return new Config();
  }

  @AfterEach
  void clear() {
    System.clearProperty("jerry.data.dir");
    System.clearProperty("jerry.config");
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> active(AlertService service) {
    return (List<Map<String, Object>>) service.snapshot().get("active");
  }

  private void advance(int seconds) {
    clock.addAndGet(seconds * 1000000000L);
  }

  private Map<String, Object> sample(int heap, int pool, int max) {
    return Json.map(
        "heap",
        Json.map("used", heap, "max", 100),
        "poolMetrics",
        Arrays.asList(
            Json.map("id", "one", "poolId", "same", "active", pool, "max", max),
            Json.map("id", "alias", "poolId", "same", "active", pool, "max", max)),
        "connectors",
        Collections.emptyList());
  }

  @Test
  void delayHysteresisUnknownAndPoolDeduplication() throws Exception {
    AlertService service = new AlertService(config(), clock::get, () -> 123L);
    service.evaluate(sample(90, 9, 10));
    assertEquals(2, service.snapshot().get("pending"));
    assertTrue(active(service).isEmpty());
    advance(60);
    service.evaluate(sample(90, 9, 10));
    assertEquals(2, active(service).size());
    service.evaluate(Json.map("heap", null, "poolMetrics", Collections.emptyList()));
    assertEquals(2, active(service).size());
    assertEquals(false, active(service).get(0).get("known"));
    service.evaluate(sample(82, 8, 10));
    advance(60);
    service.evaluate(sample(82, 8, 10));
    assertEquals(1, active(service).size());
    service.evaluate(sample(79, 7, 10));
    advance(30);
    service.evaluate(sample(79, 7, 10));
    assertTrue(active(service).isEmpty());
  }

  @Test
  void errorRateNeedsEnoughRequestsAndRulesPersist() throws Exception {
    Config config = config();
    AlertService service = new AlertService(config, clock::get, () -> 456L);
    Map<String, Object> settings =
        new LinkedHashMap<>((Map<String, Object>) service.snapshot().get("settings"));
    settings.put("delaySeconds", 0);
    service.configure(settings);
    Map<String, Object> point =
        Json.map(
            "heap",
            Json.map("used", 1, "max", 100),
            "sampleSeconds",
            10,
            "connectors",
            Arrays.asList(Json.map("requestCountRate", 1, "errorCountRate", 1)));
    service.evaluate(point);
    assertTrue(active(service).isEmpty());
    point.put("sampleSeconds", 30);
    service.evaluate(point);
    assertEquals("HTTP-Fehlerrate", active(service).get(0).get("kind"));
    assertEquals(
        0, ((Map<?, ?>) new AlertService(config).snapshot().get("settings")).get("delaySeconds"));
    settings.put("poolPercent", 101);
    assertThrows(IllegalArgumentException.class, () -> service.configure(settings));
  }
}
