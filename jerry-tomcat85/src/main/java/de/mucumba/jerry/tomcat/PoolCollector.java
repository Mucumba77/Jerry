package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.Config;
import de.mucumba.jerry.core.Json;
import de.mucumba.jerry.core.Workers;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** One bounded worker reads already-observed pool getters; never starts or borrows a connection. */
public final class PoolCollector implements AutoCloseable {
  private final TomcatAdapter tomcat;
  private final ThreadPoolExecutor worker =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<Runnable>(1),
          new Workers("pool-monitor"));
  private final AtomicBoolean running = new AtomicBoolean();
  private final long maximumAge;
  private volatile long sampledAt, started;
  private volatile List<Map<String, Object>> pools = Collections.emptyList();
  private volatile String error;
  private volatile boolean closed;

  public PoolCollector(TomcatAdapter tomcat, Config config) {
    this.tomcat = tomcat;
    maximumAge = config.number("monitor.pool.interval.seconds", 30, 10, 300) * 2000L;
  }

  public void tick() {
    if (closed || !running.compareAndSet(false, true)) return;
    started = System.currentTimeMillis();
    try {
      worker.execute(
          () -> {
            try {
              List<Map<String, Object>> next = tomcat.observedPoolMetrics();
              if (!closed) {
                pools = next;
                sampledAt = System.currentTimeMillis();
                error = null;
              }
            } catch (Exception exception) {
              error = "Poolwerte nicht verfügbar: " + exception.getClass().getSimpleName();
            } finally {
              running.set(false);
            }
          });
    } catch (RejectedExecutionException exception) {
      running.set(false);
      error = "Pool-Collector belegt.";
    }
  }

  public Map<String, Object> snapshot() {
    boolean stale = sampledAt == 0 || System.currentTimeMillis() - sampledAt > maximumAge;
    String state =
        running.get() && System.currentTimeMillis() - started > 5000
            ? "LIMITED"
            : stale ? "PENDING" : "READY";
    return Json.map(
        "sampledAt",
        sampledAt == 0 ? null : sampledAt,
        "state",
        state,
        "error",
        error,
        "pools",
        stale ? Collections.emptyList() : pools,
        "limit",
        64);
  }

  @Override
  public void close() {
    closed = true;
    worker.shutdownNow();
  }
}
