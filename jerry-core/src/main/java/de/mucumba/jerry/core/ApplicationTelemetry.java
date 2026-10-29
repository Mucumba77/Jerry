package de.mucumba.jerry.core;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicLongArray;
import java.util.concurrent.atomic.LongAdder;

/** Hot-path counters plus a bounded, non-blocking handoff for diagnostic metadata. No I/O. */
public final class ApplicationTelemetry {
  public static final class Ticket {
    final String application, operation, category;
    final long revision, started = System.nanoTime();
    final MonitoringProfiles.Mode mode;

    Ticket(
        String application,
        String category,
        String operation,
        long revision,
        MonitoringProfiles.Mode mode) {
      this.application = application;
      this.category = category;
      this.operation = operation;
      this.revision = revision;
      this.mode = mode;
    }
  }

  private static final class Counts {
    final LongAdder calls = new LongAdder(), errors = new LongAdder(), nanos = new LongAdder();
    final AtomicLong maximum = new AtomicLong();
    final AtomicLongArray histogram = new AtomicLongArray(32);

    void add(long elapsed, int status) {
      calls.increment();
      if (status >= 400) errors.increment();
      nanos.add(elapsed);
      maximum.accumulateAndGet(elapsed, Math::max);
      histogram.incrementAndGet(
          Math.min(31, 64 - Long.numberOfLeadingZeros(Math.max(1, elapsed / 1000000L))));
    }

    Map<String, Object> data(String name) {
      long count = calls.sum(), accumulated = 0;
      Long p95 = null, p99 = null;
      for (int i = 0; i < 32; i++) {
        accumulated += histogram.get(i);
        if (p95 == null && accumulated >= Math.ceil(count * .95)) p95 = 1L << i;
        if (p99 == null && accumulated >= Math.ceil(count * .99)) p99 = 1L << i;
      }
      return Json.map(
          "operation",
          name,
          "calls",
          count,
          "errors",
          errors.sum(),
          "averageMs",
          count == 0 ? null : nanos.sum() / 1000000.0 / count,
          "maxMs",
          maximum.get() / 1000000.0,
          "p95UpperMs",
          count == 0 ? null : p95,
          "p99UpperMs",
          count == 0 ? null : p99);
    }
  }

  private static final class State {
    final Map<String, Counts> operations = new ConcurrentHashMap<>();
    final ArrayDeque<Map<String, Object>> details = new ArrayDeque<>();
    final ArrayDeque<Map<String, Object>> jobs = new ArrayDeque<>();
    final LongAdder dropped = new LongAdder();
    volatile long revision, since = System.currentTimeMillis();
  }

  private static final class Event {
    final Ticket ticket;
    final long elapsed, completed;
    final int status;

    Event(Ticket ticket, long elapsed, int status) {
      this.ticket = ticket;
      this.elapsed = elapsed;
      this.status = status;
      completed = System.currentTimeMillis();
    }
  }

  private final MonitoringProfiles profiles;
  private final Map<String, State> states = new ConcurrentHashMap<>();
  private final ConcurrentLinkedQueue<Event> queue = new ConcurrentLinkedQueue<>();
  private final AtomicInteger queued = new AtomicInteger();
  private final LongAdder dropped = new LongAdder();
  private final int capacity, detailLimit, operationLimit, samplePercent;
  private volatile boolean closed;

  public ApplicationTelemetry(MonitoringProfiles profiles, Config config) {
    this.profiles = profiles;
    capacity = config.number("monitor.diagnostic.queue", 256, 8, 4096);
    detailLimit = config.number("monitor.diagnostic.eventsPerApplication", 100, 10, 1000);
    operationLimit = config.number("monitor.extended.operations", 64, 4, 256);
    samplePercent = config.number("monitor.diagnostic.samplePercent", 1, 1, 100);
  }

  public Ticket begin(String application, String method, String servlet) {
    if (closed || profiles.mode(application) == MonitoringProfiles.Mode.BASIC) return null;
    String verb = method.matches("GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS") ? method : "OTHER";
    String name =
        servlet == null ? "unmapped" : servlet.substring(0, Math.min(120, servlet.length()));
    return beginOperation(application, "HTTP", verb + " · " + name);
  }

  public Ticket beginOperation(String application, String category, String operation) {
    MonitoringProfiles.Mode mode = profiles.mode(application);
    if (closed || mode == MonitoringProfiles.Mode.BASIC) return null;
    return new Ticket(
        application,
        category,
        category + " · " + operation.substring(0, Math.min(140, operation.length())),
        profiles.revision(application),
        mode);
  }

  private boolean current(Ticket ticket) {
    return !closed
        && profiles.revision(ticket.application) == ticket.revision
        && profiles.mode(ticket.application) == ticket.mode;
  }

  public void complete(Ticket ticket, int status) {
    if (ticket == null || !current(ticket)) return;
    State state = states.get(ticket.application);
    // State creation is a control-plane operation, not an unbounded allocation per request.
    if (state == null || state.revision != ticket.revision) return;
    Counts counts = state.operations.get(ticket.operation);
    if (counts == null)
      synchronized (state.operations) {
        String key =
            state.operations.size() >= operationLimit - 1
                ? "Weitere Operationen"
                : ticket.operation;
        counts = state.operations.computeIfAbsent(key, ignored -> new Counts());
      }
    long elapsed = System.nanoTime() - ticket.started;
    counts.add(elapsed, status);
    if (!ticket.category.startsWith("QUARTZ")
        && (ticket.mode != MonitoringProfiles.Mode.DIAGNOSTIC
            || (status < 400 && ThreadLocalRandom.current().nextInt(100) >= samplePercent))) return;
    int count;
    do {
      count = queued.get();
      if (count >= capacity) {
        dropped.increment();
        state.dropped.increment();
        return;
      }
    } while (!queued.compareAndSet(count, count + 1));
    queue.offer(new Event(ticket, elapsed, status));
  }

  public void activate(String application) {
    if (profiles.mode(application) == MonitoringProfiles.Mode.BASIC) {
      states.remove(application);
      return;
    }
    long revision = profiles.revision(application);
    states.compute(
        application,
        (key, previous) -> {
          if (previous != null && previous.revision == revision) return previous;
          State next = new State();
          next.revision = revision;
          return next;
        });
  }

  public void drain() {
    Event event;
    for (int processed = 0; processed < capacity && (event = queue.poll()) != null; processed++) {
      queued.decrementAndGet();
      if (!current(event.ticket)) continue;
      State state = states.get(event.ticket.application);
      if (state == null || state.revision != event.ticket.revision) continue;
      ArrayDeque<Map<String, Object>> destination =
          event.ticket.category.startsWith("QUARTZ") ? state.jobs : state.details;
      synchronized (destination) {
        if (destination.size() >= detailLimit) {
          destination.removeFirst();
          state.dropped.increment();
        }
        destination.addLast(
            Json.map(
                "time",
                event.completed,
                "operation",
                event.ticket.operation,
                "status",
                event.status,
                "durationMs",
                event.elapsed / 1000000.0));
      }
    }
    for (String id : states.keySet()) {
      if (profiles.mode(id) == MonitoringProfiles.Mode.BASIC) states.remove(id);
      else if (profiles.mode(id) != MonitoringProfiles.Mode.DIAGNOSTIC) {
        State state = states.get(id);
        if (state != null)
          synchronized (state.details) {
            state.details.clear();
          }
      }
    }
  }

  public Map<String, Object> snapshot(String application) {
    State state = states.get(application);
    List<Map<String, Object>> operations = new ArrayList<>(),
        details = new ArrayList<>(),
        jobs = new ArrayList<>();
    if (state != null && profiles.mode(application) != MonitoringProfiles.Mode.BASIC) {
      for (Map.Entry<String, Counts> entry : state.operations.entrySet())
        operations.add(entry.getValue().data(entry.getKey()));
      if (profiles.mode(application) == MonitoringProfiles.Mode.DIAGNOSTIC)
        synchronized (state.details) {
          details.addAll(state.details);
        }
      synchronized (state.jobs) {
        jobs.addAll(state.jobs);
      }
    }
    return Json.map(
        "since",
        state == null ? null : state.since,
        "operations",
        operations,
        "details",
        details,
        "jobs",
        jobs,
        "dropped",
        state == null ? 0 : state.dropped.sum(),
        "samplePercent",
        samplePercent,
        "eventLimit",
        detailLimit,
        "operationLimit",
        operationLimit);
  }

  public Map<String, Object> diagnostics() {
    return Json.map(
        "queued",
        queued.get(),
        "queueCapacity",
        capacity,
        "dropped",
        dropped.sum(),
        "applications",
        states.size());
  }

  public void close() {
    closed = true;
    queue.clear();
    queued.set(0);
    states.clear();
  }
}
