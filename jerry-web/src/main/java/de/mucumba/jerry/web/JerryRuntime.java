package de.mucumba.jerry.web;

import de.mucumba.jerry.core.AlertService;
import de.mucumba.jerry.core.ApplicationTelemetry;
import de.mucumba.jerry.core.Audit;
import de.mucumba.jerry.core.Config;
import de.mucumba.jerry.core.LogService;
import de.mucumba.jerry.core.MetricStore;
import de.mucumba.jerry.core.Monitoring;
import de.mucumba.jerry.core.MonitoringProfiles;
import de.mucumba.jerry.core.SqlService;
import de.mucumba.jerry.core.UserStore;
import de.mucumba.jerry.core.Workers;
import de.mucumba.jerry.tomcat.ApplicationJmx;
import de.mucumba.jerry.tomcat.ApplicationMonitor;
import de.mucumba.jerry.tomcat.InstrumentationBridge;
import de.mucumba.jerry.tomcat.PoolCollector;
import de.mucumba.jerry.tomcat.TomcatAdapter;
import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.logging.Logger;
import org.apache.catalina.Wrapper;

/**
 * Owns the service lifecycle, monitoring collectors and per-session resources for one Jerry
 * deployment.
 */
final class JerryRuntime implements AutoCloseable {
  static final String KEY = JerryRuntime.class.getName();
  final Config config;
  final Audit audit;
  final TomcatAdapter tomcat;
  final MonitoringProfiles profiles;
  final ApplicationTelemetry telemetry;
  final ApplicationMonitor applications;
  final InstrumentationBridge instrumentation;
  final PoolCollector pools;
  final AlertService alerts;
  final ApplicationJmx jmx;
  final SqlService sql;
  final LogService logs;
  final Monitoring monitoring = new Monitoring();
  final MetricStore metrics;
  final UserStore users;
  final ScheduledExecutorService scheduler =
      Executors.newScheduledThreadPool(2, new Workers("monitor"));
  final Set<EventStream> streams = ConcurrentHashMap.newKeySet();
  volatile Map<String, Object> latest;
  volatile String collectionError;

  JerryRuntime(Wrapper wrapper) throws Exception {
    config = new Config();
    audit = new Audit(config);
    profiles = new MonitoringProfiles(config);
    telemetry = new ApplicationTelemetry(profiles, config);
    tomcat = new TomcatAdapter(wrapper, config, telemetry);
    applications = new ApplicationMonitor(profiles, telemetry, tomcat, config);
    instrumentation = new InstrumentationBridge(tomcat, profiles, telemetry);
    pools = new PoolCollector(tomcat, config);
    alerts = new AlertService(config);
    jmx = new ApplicationJmx(config);
    sql = new SqlService(config, audit, tomcat);
    logs = new LogService(config, audit);
    metrics = new MetricStore(config);
    users = new UserStore(config);
    sample();
    scheduler.scheduleWithFixedDelay(
        this::sample,
        config.number("monitor.interval.seconds", 10, 1, 60),
        config.number("monitor.interval.seconds", 10, 1, 60),
        TimeUnit.SECONDS);
    scheduler.scheduleWithFixedDelay(telemetry::drain, 1, 1, TimeUnit.SECONDS);
    scheduler.scheduleWithFixedDelay(
        pools::tick,
        1,
        config.number("monitor.pool.interval.seconds", 30, 10, 300),
        TimeUnit.SECONDS);
    scheduler.scheduleWithFixedDelay(
        () -> {
          try {
            applications.tick();
            instrumentation.tick();
          } catch (Exception exception) {
            Logger.getLogger("Jerry")
                .log(Level.WARNING, "Application monitoring failed", exception);
          }
        },
        1,
        10,
        TimeUnit.SECONDS);
    scheduler.scheduleWithFixedDelay(
        () -> {
          try {
            sql.reap();
            logs.reap();
          } catch (Exception exception) {
            Logger.getLogger("Jerry").log(Level.WARNING, "Cleanup failed", exception);
          }
        },
        15,
        15,
        TimeUnit.SECONDS);
  }

  private void sample() {
    try {
      Map<String, Object> data = monitoring.snapshot();
      data.put("applicationMetrics", tomcat.requestMetrics());
      data.put("connectorBusyWorkers", tomcat.connectorBusyWorkers());
      data.put("clusterReplication", tomcat.clusterMetrics());
      Map<String, Object> poolSnapshot = pools.snapshot();
      data.put("poolMetrics", poolSnapshot.get("pools"));
      data.put("poolCollectedAt", poolSnapshot.get("sampledAt"));
      data.put("poolCollectorState", poolSnapshot.get("state"));
      alerts.evaluate(data);
      data.put("alerts", alerts.snapshot());
      latest = data;
      try {
        metrics.append(data);
        collectionError = null;
      } catch (IOException exception) {
        collectionError = exception.getMessage();
        Logger.getLogger("Jerry").log(Level.WARNING, "Metric persistence failed", exception);
      }
      for (EventStream stream : streams) stream.offer(data);
    } catch (Exception exception) {
      collectionError = exception.getMessage();
      Logger.getLogger("Jerry").log(Level.WARNING, "Metric collection failed", exception);
    }
  }

  void closeOwner(String owner) {
    sql.closeOwner(owner);
    logs.closeOwner(owner);
    for (EventStream stream : streams) if (owner.equals(stream.owner)) stream.close();
  }

  @Override
  public void close() {
    scheduler.shutdownNow();
    for (EventStream stream : streams) stream.close();
    streams.clear();
    sql.close();
    logs.close();
    applications.close();
    instrumentation.close();
    pools.close();
    jmx.close();
    telemetry.close();
    tomcat.close();
    try {
      scheduler.awaitTermination(5, TimeUnit.SECONDS);
    } catch (InterruptedException exception) {
      Thread.currentThread().interrupt();
    }
  }
}
