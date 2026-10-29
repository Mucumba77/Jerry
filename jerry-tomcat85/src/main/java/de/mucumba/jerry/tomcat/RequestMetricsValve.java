package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.ApplicationTelemetry;
import de.mucumba.jerry.core.Json;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicLongArray;
import java.util.concurrent.atomic.LongAdder;
import javax.servlet.AsyncEvent;
import javax.servlet.AsyncListener;
import javax.servlet.ServletException;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;

/**
 * Measures real completions, including asynchronous requests, without retaining request objects.
 */
public final class RequestMetricsValve extends ValveBase {
  private static final String MARKER = RequestMetricsValve.class.getName();
  private final Map<String, Counts> applications = new ConcurrentHashMap<>();
  private final ApplicationTelemetry telemetry;

  private static final class Counts {
    final String applicationId;

    Counts(String name) {
      applicationId =
          java.util.Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(name.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    final LongAdder requests = new LongAdder(), errors = new LongAdder(), nanos = new LongAdder();
    final AtomicLong maxNanos = new AtomicLong();
    final AtomicLongArray histogram = new AtomicLongArray(32);
    final long since = System.currentTimeMillis();
  }

  public RequestMetricsValve(ApplicationTelemetry telemetry) {
    super(true);
    this.telemetry = telemetry;
  }

  @Override
  public void invoke(final Request request, final Response response)
      throws IOException, ServletException {
    if (request.getAttribute(MARKER) != null) {
      getNext().invoke(request, response);
      return;
    }
    request.setAttribute(MARKER, Boolean.TRUE);
    final long start = System.nanoTime();
    final String name =
        request.getHost().getName()
            + "|"
            + (request.getContext() == null ? "" : request.getContext().getName());
    // Async redispatch and completion can race; count each request at most once.
    final AtomicBoolean recorded = new AtomicBoolean();
    final Counts initial =
        applications.size() >= 512 && !applications.containsKey(name)
            ? null
            : applications.computeIfAbsent(name, key -> new Counts(key));
    final ApplicationTelemetry.Ticket ticket =
        initial == null
            ? null
            : telemetry.begin(
                initial.applicationId,
                request.getMethod(),
                request.getWrapper() == null ? "unmapped" : request.getWrapper().getName());
    Runnable complete =
        () -> {
          if (!recorded.compareAndSet(false, true)
              || (applications.size() >= 512 && !applications.containsKey(name))) return;
          Counts counts = initial;
          if (counts == null) return;
          long elapsed = System.nanoTime() - start;
          counts.requests.increment();
          if (response.getStatus() >= 400) counts.errors.increment();
          counts.nanos.add(elapsed);
          counts.maxNanos.accumulateAndGet(elapsed, Math::max);
          long milliseconds = Math.max(1L, elapsed / 1000000L);
          int bucket = Math.min(31, 64 - Long.numberOfLeadingZeros(milliseconds));
          counts.histogram.incrementAndGet(bucket);
          telemetry.complete(ticket, response.getStatus());
        };
    try {
      org.apache.catalina.Session session = request.getSessionInternal(false);
      if (session != null) session.setNote("de.mucumba.jerry.lastIp", request.getRemoteAddr());
      getNext().invoke(request, response);
    } finally {
      if (request.isAsyncStarted()) {
        // Re-register after a new async cycle so timing ends on actual completion.
        AsyncListener listener =
            new AsyncListener() {
              @Override
              public void onComplete(AsyncEvent event) {
                complete.run();
              }

              @Override
              public void onTimeout(AsyncEvent event) {}

              @Override
              public void onError(AsyncEvent event) {}

              @Override
              public void onStartAsync(AsyncEvent event) {
                event.getAsyncContext().addListener(this);
              }
            };
        try {
          request.getAsyncContext().addListener(listener);
        } catch (IllegalStateException exception) {
          complete.run();
        }
      } else complete.run();
    }
  }

  public List<Map<String, Object>> snapshot() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Map.Entry<String, Counts> entry : applications.entrySet()) {
      Counts counts = entry.getValue();
      long total = counts.requests.sum(), accumulated = 0;
      Long p95 = null, p99 = null;
      for (int i = 0; i < 32; i++) {
        accumulated += counts.histogram.get(i);
        if (p95 == null && accumulated >= Math.ceil(total * .95)) p95 = 1L << i;
        if (p99 == null && accumulated >= Math.ceil(total * .99)) p99 = 1L << i;
      }
      result.add(
          Json.map(
              "application",
              entry.getKey(),
              "requests",
              total,
              "errors",
              counts.errors.sum(),
              "averageMs",
              total == 0 ? null : counts.nanos.sum() / 1000000.0 / total,
              "maxMs",
              counts.maxNanos.get() / 1000000.0,
              "p95UpperMs",
              total == 0 ? null : p95,
              "p99UpperMs",
              total == 0 ? null : p99,
              "since",
              counts.since));
    }
    return result;
  }
}
