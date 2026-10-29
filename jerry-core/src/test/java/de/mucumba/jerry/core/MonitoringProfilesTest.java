package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class MonitoringProfilesTest {
  @TempDir Path directory;

  private Config config() throws Exception {
    System.setProperty("jerry.data.dir", directory.toString());
    System.setProperty("jerry.config", directory.resolve("absent").toString());
    return new Config();
  }

  @AfterEach
  void clear() {
    for (String key :
        new String[] {
          "data.dir",
          "config",
          "monitor.diagnostic.samplePercent",
          "monitor.diagnostic.queue",
          "monitor.diagnostic.eventsPerApplication"
        }) System.clearProperty("jerry." + key);
  }

  @Test
  void baselinePersistsButDiagnosticNeverSurvivesRestart() throws Exception {
    Config config = config();
    MonitoringProfiles profiles = new MonitoringProfiles(config);
    assertEquals(MonitoringProfiles.Mode.BASIC, profiles.mode("app"));
    profiles.change("app", "EXTENDED", 0);
    profiles.change("app", "DIAGNOSTIC", 10);
    assertEquals(MonitoringProfiles.Mode.DIAGNOSTIC, profiles.mode("app"));
    assertEquals(MonitoringProfiles.Mode.EXTENDED, new MonitoringProfiles(config).mode("app"));
  }

  @Test
  void expiryUsesMonotonicTimeAndReturnsToPreviousBaseline() throws Exception {
    AtomicLong nanos = new AtomicLong(), wall = new AtomicLong(100000);
    MonitoringProfiles profiles = new MonitoringProfiles(config(), nanos::get, wall::get);
    profiles.change("app", "EXTENDED", 0);
    profiles.change("app", "DIAGNOSTIC", 10);
    wall.set(-500000);
    assertEquals(MonitoringProfiles.Mode.DIAGNOSTIC, profiles.mode("app"));
    nanos.set(10000000000L);
    assertEquals(MonitoringProfiles.Mode.EXTENDED, profiles.mode("app"));
    profiles.change("basic", "DIAGNOSTIC", 10);
    nanos.addAndGet(10000000000L);
    assertEquals(MonitoringProfiles.Mode.BASIC, profiles.mode("basic"));
  }

  @Test
  void durationConcurrencyAndUnknownModesAreRejected() throws Exception {
    MonitoringProfiles profiles = new MonitoringProfiles(config());
    assertThrows(IllegalArgumentException.class, () -> profiles.change("a", "DIAGNOSTIC", 0));
    assertThrows(IllegalArgumentException.class, () -> profiles.change("a", "DIAGNOSTIC", 901));
    assertThrows(IllegalArgumentException.class, () -> profiles.change("a", "NONE", 0));
    profiles.change("a", "DIAGNOSTIC", 10);
    profiles.change("b", "DIAGNOSTIC", 10);
    assertThrows(IllegalStateException.class, () -> profiles.change("c", "DIAGNOSTIC", 10));
    profiles.stop("a");
    profiles.change("c", "DIAGNOSTIC", 10);
  }

  @Test
  void basicCollectsNoDetailsAndLateCompletionsAreDiscarded() throws Exception {
    Config config = config();
    MonitoringProfiles profiles = new MonitoringProfiles(config);
    ApplicationTelemetry telemetry = new ApplicationTelemetry(profiles, config);
    assertNull(telemetry.begin("app", "GET", "test"));
    profiles.change("app", "EXTENDED", 0);
    telemetry.activate("app");
    ApplicationTelemetry.Ticket ticket = telemetry.begin("app", "GET", "test");
    profiles.change("app", "BASIC", 0);
    telemetry.complete(ticket, 200);
    telemetry.drain();
    assertTrue(((java.util.List<?>) telemetry.snapshot("app").get("operations")).isEmpty());
  }

  @Test
  void diagnosticQueueAndStoredHistoryAreBounded() throws Exception {
    System.setProperty("jerry.monitor.diagnostic.samplePercent", "100");
    System.setProperty("jerry.monitor.diagnostic.queue", "8");
    System.setProperty("jerry.monitor.diagnostic.eventsPerApplication", "10");
    Config config = config();
    MonitoringProfiles profiles = new MonitoringProfiles(config);
    ApplicationTelemetry telemetry = new ApplicationTelemetry(profiles, config);
    profiles.change("app", "DIAGNOSTIC", 10);
    telemetry.activate("app");
    for (int i = 0; i < 50; i++) telemetry.complete(telemetry.begin("app", "GET", "test"), 500);
    assertEquals(8, telemetry.diagnostics().get("queued"));
    assertEquals(42L, telemetry.diagnostics().get("dropped"));
    telemetry.drain();
    for (int i = 0; i < 8; i++) telemetry.complete(telemetry.begin("app", "GET", "test"), 500);
    telemetry.drain();
    assertEquals(10, ((java.util.List<?>) telemetry.snapshot("app").get("details")).size());
    profiles.stop("app");
    telemetry.drain();
    assertTrue(((java.util.List<?>) telemetry.snapshot("app").get("details")).isEmpty());
  }

  @Test
  void manyDynamicOperationsCannotExhaustCardinalityAndExpiryRejectsInflightEvents()
      throws Exception {
    Config config = config();
    AtomicLong nanos = new AtomicLong();
    MonitoringProfiles profiles =
        new MonitoringProfiles(config, nanos::get, System::currentTimeMillis);
    ApplicationTelemetry telemetry = new ApplicationTelemetry(profiles, config);
    profiles.change("app", "DIAGNOSTIC", 10);
    telemetry.activate("app");
    for (int i = 0; i < 1000; i++)
      telemetry.complete(telemetry.beginOperation("app", "QUARTZ", "dynamic-" + i), 200);
    assertEquals(64, ((java.util.List<?>) telemetry.snapshot("app").get("operations")).size());
    ApplicationTelemetry.Ticket pending = telemetry.begin("app", "GET", "test");
    nanos.set(10000000000L);
    telemetry.complete(pending, 500);
    telemetry.drain();
    assertEquals(0, telemetry.diagnostics().get("applications"));
    assertTrue(((java.util.List<?>) telemetry.snapshot("app").get("details")).isEmpty());
    assertEquals(0, telemetry.diagnostics().get("queued"));
  }
}
