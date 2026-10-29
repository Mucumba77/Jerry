package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.ApplicationTelemetry;
import de.mucumba.jerry.core.Json;
import de.mucumba.jerry.core.MonitoringProfiles;
import de.mucumba.jerry.core.Workers;
import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BiConsumer;
import java.util.function.BiFunction;
import javax.servlet.ServletContext;
import org.apache.catalina.Context;

/**
 * Shares only JDK interfaces across webapp classloaders; the application opts in by installing the
 * adapters.
 */
public final class InstrumentationBridge implements AutoCloseable {
  public static final String ATTRIBUTE = "de.mucumba.jerry.monitor.bridge.v1";

  private static final class Entry {
    final WeakReference<ServletContext> context;
    final Map<String, Object> bridge;

    Entry(ServletContext context, Map<String, Object> bridge) {
      this.context = new WeakReference<>(context);
      this.bridge = bridge;
    }
  }

  private final TomcatAdapter tomcat;
  private final MonitoringProfiles profiles;
  private final ApplicationTelemetry telemetry;
  private final Map<String, Entry> entries = new ConcurrentHashMap<>();
  private final ThreadPoolExecutor worker =
      new ThreadPoolExecutor(
          1,
          1,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<Runnable>(64),
          new Workers("instrumentation"));
  private final AtomicBoolean scheduled = new AtomicBoolean();
  private volatile boolean closed;

  public InstrumentationBridge(
      TomcatAdapter tomcat, MonitoringProfiles profiles, ApplicationTelemetry telemetry) {
    this.tomcat = tomcat;
    this.profiles = profiles;
    this.telemetry = telemetry;
  }

  public void tick() {
    if (closed || !scheduled.compareAndSet(false, true)) return;
    try {
      worker.execute(
          () -> {
            try {
              collect();
            } finally {
              scheduled.set(false);
            }
          });
    } catch (RejectedExecutionException ignored) {
      scheduled.set(false);
    }
  }

  private void collect() {
    if (closed) return;
    Set<String> live = new HashSet<>();
    for (Context context : tomcat.contexts()) {
      String id = TomcatAdapter.id(context);
      live.add(id);
      refresh(context, id);
    }
    for (String id : new ArrayList<>(entries.keySet())) if (!live.contains(id)) remove(id);
  }

  public void changed(String id) {
    if (!closed)
      try {
        worker.execute(
            () -> {
              if (!closed) refresh(tomcat.context(id), id);
            });
      } catch (RejectedExecutionException ignored) {
      }
  }

  private void refresh(Context context, String id) {
    if (closed
        || profiles.mode(id) == MonitoringProfiles.Mode.BASIC
        || !context.getState().isAvailable()) {
      remove(id);
      return;
    }
    ServletContext servlet = context.getServletContext();
    Entry old = entries.get(id);
    if (old != null && old.context.get() != servlet) {
      remove(id);
      old = null;
    }
    if (old != null && servlet.getAttribute(ATTRIBUTE) == old.bridge) return;
    if (servlet.getAttribute(ATTRIBUTE) != null)
      return; // Never overwrite an application's own attribute.
    BiFunction<String, String, Object> begin =
        (category, operation) -> {
          if (category == null) return null;
          String clean;
          switch (category) {
            case "HTTP_OUTBOUND":
              clean =
                  operation != null && operation.matches("GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS")
                      ? operation
                      : "OTHER";
              break;
            case "SQL":
              clean =
                  Arrays.asList("Query", "Update", "Batch", "Execute").contains(operation)
                      ? operation
                      : "Execute";
              break;
            case "JMS_SEND":
              clean = "Senden";
              break;
            case "JMS_RECEIVE":
              clean = "Empfangen";
              break;
            default:
              return null;
          }
          return telemetry.beginOperation(id, category, clean);
        };
    BiConsumer<Object, Integer> complete =
        (ticket, status) -> {
          if (ticket instanceof ApplicationTelemetry.Ticket)
            telemetry.complete((ApplicationTelemetry.Ticket) ticket, status == null ? 500 : status);
        };
    Map<String, Object> bridge =
        Collections.unmodifiableMap(Json.map("version", 1, "begin", begin, "complete", complete));
    servlet.setAttribute(ATTRIBUTE, bridge);
    entries.put(id, new Entry(servlet, bridge));
    if (closed || profiles.mode(id) == MonitoringProfiles.Mode.BASIC) remove(id);
  }

  private void remove(String id) {
    Entry entry = entries.remove(id);
    if (entry == null) return;
    ServletContext servlet = entry.context.get();
    if (servlet != null)
      try {
        if (servlet.getAttribute(ATTRIBUTE) == entry.bridge) servlet.removeAttribute(ATTRIBUTE);
      } catch (IllegalStateException ignored) {
      }
  }

  public Map<String, Object> state(String id) {
    Entry entry = entries.get(id);
    ServletContext servlet = entry == null ? null : entry.context.get();
    return Json.map(
        "bridgeReady",
        servlet != null && servlet.getAttribute(ATTRIBUTE) == entry.bridge,
        "attribute",
        ATTRIBUTE,
        "adapterRequired",
        true);
  }

  @Override
  public void close() {
    closed = true;
    worker.shutdownNow();
    for (String id : new ArrayList<>(entries.keySet())) remove(id);
  }
}
