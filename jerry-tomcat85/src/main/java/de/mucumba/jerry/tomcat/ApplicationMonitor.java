package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.ApplicationTelemetry;
import de.mucumba.jerry.core.Config;
import de.mucumba.jerry.core.Json;
import de.mucumba.jerry.core.MonitoringProfiles;
import de.mucumba.jerry.core.Workers;
import java.lang.ref.WeakReference;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.LongAdder;
import org.apache.catalina.Context;

/** Reads initialized application objects only, with bounded worker and result counts. */
public final class ApplicationMonitor implements AutoCloseable {
  private static final class Registration {
    final WeakReference<Object> manager;
    final String name;

    Registration(Object manager, String name) {
      this.manager = new WeakReference<>(manager);
      this.name = name;
    }

    void remove() {
      Object target = manager.get();
      if (target != null) {
        call(target, "removeJobListener", new Class<?>[] {String.class}, name);
        call(target, "removeTriggerListener", new Class<?>[] {String.class}, name);
      }
    }
  }

  private static final class Slot {
    final String token = UUID.randomUUID().toString();
    final AtomicBoolean running = new AtomicBoolean();
    final List<Registration> registrations =
        Collections.synchronizedList(new ArrayList<Registration>());
    volatile Map<String, Object> value;
    volatile long started, collected;
    volatile String error;
    volatile int loader;
  }

  private final MonitoringProfiles profiles;
  private final ApplicationTelemetry telemetry;
  private final TomcatAdapter tomcat;
  private final Map<String, Slot> slots = new ConcurrentHashMap<>();
  private final ThreadPoolExecutor workers =
      new ThreadPoolExecutor(
          2,
          2,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<Runnable>(16),
          new Workers("application-monitor"));
  private final String listenerPrefix = "Jerry-" + UUID.randomUUID() + "-";
  private final LongAdder rejected = new LongAdder();
  private final long budgetNanos;
  private volatile boolean closed;

  public ApplicationMonitor(
      MonitoringProfiles profiles,
      ApplicationTelemetry telemetry,
      TomcatAdapter tomcat,
      Config config) {
    this.profiles = profiles;
    this.telemetry = telemetry;
    this.tomcat = tomcat;
    budgetNanos = config.number("monitor.application.budgetMs", 1000, 100, 5000) * 1000000L;
  }

  public void changed(String id) {
    telemetry.activate(id);
    Slot slot = slots.get(id);
    if (slot != null) {
      slot.value = null;
      if (profiles.mode(id) == MonitoringProfiles.Mode.BASIC) {
        slots.remove(id, slot);
        detach(slot);
      }
    }
  }

  private static void detach(Slot slot) {
    synchronized (slot.registrations) {
      for (Registration registration : slot.registrations) registration.remove();
      slot.registrations.clear();
    }
  }

  public void tick() {
    if (closed) return;
    java.util.Set<String> live = new java.util.HashSet<>();
    for (Context context : tomcat.contexts()) {
      String id = TomcatAdapter.id(context);
      live.add(id);
      telemetry.activate(id);
      if (profiles.mode(id) == MonitoringProfiles.Mode.BASIC || !context.getState().isAvailable()) {
        Slot old = slots.remove(id);
        if (old != null) detach(old);
        continue;
      }
      if (slots.size() >= 64 && !slots.containsKey(id)) {
        rejected.increment();
        continue;
      }
      int loader =
          System.identityHashCode(
              context.getLoader() == null ? context : context.getLoader().getClassLoader());
      Slot previousSlot = slots.get(id);
      if (previousSlot != null && previousSlot.loader != loader) {
        slots.remove(id, previousSlot);
        detach(previousSlot);
      }
      Slot slot =
          slots.computeIfAbsent(
              id,
              ignored -> {
                Slot next = new Slot();
                next.loader = loader;
                return next;
              });
      if (!slot.running.compareAndSet(false, true)) {
        if (System.nanoTime() - slot.started > budgetNanos)
          slot.error =
              "Zeitbudget überschritten; dieser Collector wird nicht parallel erneut gestartet.";
        continue;
      }
      slot.started = System.nanoTime();
      long revision = profiles.revision(id);
      try {
        workers.execute(
            () -> {
              ClassLoader previous = Thread.currentThread().getContextClassLoader();
              try {
                if (closed
                    || profiles.mode(id) == MonitoringProfiles.Mode.BASIC
                    || profiles.revision(id) != revision) return;
                Thread.currentThread().setContextClassLoader(context.getLoader().getClassLoader());
                Map<String, Object> value = collect(context, id, slot, slot.started + budgetNanos);
                if (!closed
                    && profiles.mode(id) != MonitoringProfiles.Mode.BASIC
                    && profiles.revision(id) == revision
                    && slot.loader == loader) {
                  slot.value = value;
                  slot.collected = System.currentTimeMillis();
                  slot.error = null;
                }
              } catch (Exception exception) {
                slot.error =
                    "Komponentenwerte momentan nicht verfügbar: "
                        + exception.getClass().getSimpleName();
              } finally {
                Thread.currentThread().setContextClassLoader(previous);
                slot.running.set(false);
              }
            });
      } catch (java.util.concurrent.RejectedExecutionException exception) {
        slot.running.set(false);
        slot.error = "Collector-Warteschlange belegt.";
        rejected.increment();
      }
    }
    for (String id : new ArrayList<>(slots.keySet()))
      if (!live.contains(id)) {
        Slot old = slots.remove(id);
        if (old != null) detach(old);
      }
  }

  public Map<String, Object> snapshot(String id) {
    Slot slot = slots.get(id);
    if (profiles.mode(id) == MonitoringProfiles.Mode.BASIC)
      return Json.map("collectedAt", null, "state", "BASIC", "components", null);
    return Json.map(
        "collectedAt",
        slot == null ? null : slot.collected,
        "state",
        slot == null
            ? "PENDING"
            : slot.error != null ? "LIMITED" : slot.value == null ? "PENDING" : "READY",
        "error",
        slot == null ? null : slot.error,
        "components",
        slot == null ? null : slot.value);
  }

  public Map<String, Object> diagnostics() {
    return Json.map(
        "workers",
        2,
        "active",
        workers.getActiveCount(),
        "queued",
        workers.getQueue().size(),
        "queueCapacity",
        16,
        "rejected",
        rejected.sum());
  }

  private Map<String, Object> collect(Context context, String id, Slot slot, long deadline)
      throws Exception {
    List<Map<String, Object>> spring = new ArrayList<>(),
        quartz = new ArrayList<>(),
        jms = new ArrayList<>(),
        executors = new ArrayList<>(),
        orm = new ArrayList<>();
    IdentityHashMap<Object, Boolean> seen = new IdentityHashMap<>(),
        factories = new IdentityHashMap<>();
    Enumeration<String> attributes = context.getServletContext().getAttributeNames();
    int contexts = 0, inspected = 0;
    boolean truncated = false;
    while (attributes.hasMoreElements() && contexts < 16) {
      if (System.nanoTime() > deadline) {
        truncated = true;
        break;
      }
      String name = attributes.nextElement();
      if (!name.startsWith("org.springframework.web.context.WebApplicationContext.")
          && !name.startsWith("org.springframework.web.servlet.FrameworkServlet.CONTEXT."))
        continue;
      if (System.nanoTime() > deadline) {
        truncated = true;
        break;
      }
      Object application = context.getServletContext().getAttribute(name);
      if (application == null || seen.put(application, true) != null) continue;
      contexts++;
      Object factory = call(application, "getAutowireCapableBeanFactory"),
          names = call(factory, "getSingletonNames");
      if (!(names instanceof String[])) continue;
      spring.add(
          Json.map(
              "name",
              name,
              "active",
              call(application, "isActive"),
              "singletons",
              ((String[]) names).length));
      for (String beanName : (String[]) names) {
        if (inspected++ >= 256 || System.nanoTime() > deadline) {
          truncated = true;
          break;
        }
        Object bean = call(factory, "getSingleton", new Class<?>[] {String.class}, beanName);
        if (bean == null || seen.put(bean, true) != null) continue;
        if (isType(bean, "org.springframework.scheduling.quartz.SchedulerFactoryBean"))
          bean = call(bean, "getScheduler");
        inspect(beanName, bean, id, slot, quartz, jms, executors, orm, factories);
        Object containers = call(bean, "getListenerContainers");
        if (containers instanceof Iterable) {
          int count = 0;
          for (Object listener : (Iterable<?>) containers) {
            if (count++ >= 64) {
              truncated = true;
              break;
            }
            if (listener != null && seen.put(listener, true) == null)
              inspect(
                  beanName + "/" + count,
                  listener,
                  id,
                  slot,
                  quartz,
                  jms,
                  executors,
                  orm,
                  factories);
          }
        }
      }
    }
    return Json.map(
        "spring",
        spring,
        "quartz",
        quartz,
        "jms",
        jms,
        "executors",
        executors,
        "orm",
        orm,
        "inspectedBeans",
        inspected,
        "truncated",
        truncated,
        "note",
        "JMS-Werte betreffen lokale Clients. Laufzeiten von JMS/SQL und ausgehenden Webservices benötigen zusätzliche Instrumentierung. Quartz-Werte betreffen diesen JVM-Knoten.");
  }

  private void inspect(
      String name,
      Object bean,
      String id,
      Slot slot,
      List<Map<String, Object>> quartz,
      List<Map<String, Object>> jms,
      List<Map<String, Object>> executors,
      List<Map<String, Object>> orm,
      IdentityHashMap<Object, Boolean> factories) {
    if (bean == null) return;
    if (isType(bean, "org.quartz.Scheduler") && quartz.size() < 32) {
      Object metadata = call(bean, "getMetaData"),
          running = call(bean, "getCurrentlyExecutingJobs");
      quartz.add(
          Json.map(
              "bean",
              name,
              "name",
              call(bean, "getSchedulerName"),
              "started",
              call(bean, "isStarted"),
              "standby",
              call(bean, "isInStandbyMode"),
              "shutdown",
              call(bean, "isShutdown"),
              "executed",
              call(metadata, "getNumberOfJobsExecuted"),
              "clustered",
              call(metadata, "isJobStoreClustered"),
              "running",
              running instanceof java.util.Collection
                  ? ((java.util.Collection<?>) running).size()
                  : null,
              "listenersAttached",
              registerQuartz(bean, id, slot)));
    }
    if (isType(bean, "org.springframework.jms.listener.MessageListenerContainer")
        && jms.size() < 64)
      jms.add(
          Json.map(
              "name",
              name,
              "destination",
              call(bean, "getDestinationName"),
              "running",
              call(bean, "isRunning"),
              "active",
              call(bean, "isActive"),
              "consumers",
              call(bean, "getActiveConsumerCount"),
              "scheduledConsumers",
              call(bean, "getScheduledConsumerCount"),
              "minConsumers",
              call(bean, "getConcurrentConsumers"),
              "maxConsumers",
              call(bean, "getMaxConcurrentConsumers"),
              "recovering",
              call(bean, "isRecovering")));
    if (isType(bean, "org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor")
        && executors.size() < 64) {
      Object executor = call(bean, "getThreadPoolExecutor"), queue = call(executor, "getQueue");
      executors.add(
          Json.map(
              "name",
              name,
              "active",
              call(executor, "getActiveCount"),
              "threads",
              call(executor, "getPoolSize"),
              "max",
              call(executor, "getMaximumPoolSize"),
              "queued",
              call(queue, "size"),
              "completed",
              call(executor, "getCompletedTaskCount")));
    }
    Object nativeFactory = bean;
    String source = "SessionFactory";
    if (isType(bean, "org.springframework.orm.jpa.EntityManagerFactoryInfo")) {
      nativeFactory = call(bean, "getNativeEntityManagerFactory");
      source = "Spring JPA";
    } else if (isType(bean, "org.springframework.orm.hibernate5.LocalSessionFactoryBean")
        || isType(bean, "org.springframework.orm.hibernate4.LocalSessionFactoryBean")) {
      nativeFactory = call(bean, "getObject");
      source = "Spring Hibernate";
    }
    if (nativeFactory != null
        && isType(nativeFactory, "org.hibernate.SessionFactory")
        && orm.size() < 32
        && factories.put(nativeFactory, true) == null) {
      Object statistics = call(nativeFactory, "getStatistics");
      orm.add(
          Json.map(
              "name",
              name,
              "source",
              source,
              "enabled",
              call(statistics, "isStatisticsEnabled"),
              "queries",
              call(statistics, "getQueryExecutionCount"),
              "entityLoads",
              call(statistics, "getEntityLoadCount"),
              "cacheHits",
              call(statistics, "getSecondLevelCacheHitCount"),
              "cacheMisses",
              call(statistics, "getSecondLevelCacheMissCount"),
              "sessionsOpened",
              call(statistics, "getSessionOpenCount"),
              "transactions",
              call(statistics, "getTransactionCount"),
              "maxQueryMs",
              call(statistics, "getQueryExecutionMaxTime")));
    }
  }

  private boolean registerQuartz(Object scheduler, String id, Slot slot) {
    if (closed || profiles.mode(id) == MonitoringProfiles.Mode.BASIC || slots.get(id) != slot)
      return false;
    Object manager = call(scheduler, "getListenerManager");
    if (manager == null) return false;
    String name = listenerPrefix + id + "-" + slot.token;
    if (call(manager, "getJobListener", new Class<?>[] {String.class}, name) != null) return true;
    try {
      ClassLoader loader = scheduler.getClass().getClassLoader();
      Class<?> job = Class.forName("org.quartz.JobListener", false, loader),
          trigger = Class.forName("org.quartz.TriggerListener", false, loader);
      Map<String, ApplicationTelemetry.Ticket> active = new ConcurrentHashMap<>();
      java.lang.reflect.InvocationHandler handler =
          (proxy, method, args) -> {
            switch (method.getName()) {
              case "getName":
                return name;
              case "hashCode":
                return System.identityHashCode(proxy);
              case "equals":
                return proxy == args[0];
              case "toString":
                return name;
              case "vetoJobExecution":
                return false;
              case "jobToBeExecuted":
                {
                  if (active.size() >= 128) return null;
                  Object execution = args[0],
                      key = call(execution, "getFireInstanceId"),
                      detail = call(execution, "getJobDetail");
                  ApplicationTelemetry.Ticket ticket =
                      telemetry.beginOperation(
                          id, "QUARTZ", String.valueOf(call(detail, "getKey")));
                  if (ticket != null && key != null) active.put(String.valueOf(key), ticket);
                  return null;
                }
              case "jobWasExecuted":
                {
                  Object key = call(args[0], "getFireInstanceId");
                  ApplicationTelemetry.Ticket ticket = active.remove(String.valueOf(key));
                  telemetry.complete(ticket, args[1] == null ? 200 : 500);
                  return null;
                }
              case "triggerMisfired":
                {
                  ApplicationTelemetry.Ticket ticket =
                      telemetry.beginOperation(
                          id, "QUARTZ_MISFIRE", String.valueOf(call(args[0], "getKey")));
                  telemetry.complete(ticket, 409);
                  return null;
                }
              default:
                return null;
            }
          };
      Object jobListener = Proxy.newProxyInstance(loader, new Class<?>[] {job}, handler),
          triggerListener = Proxy.newProxyInstance(loader, new Class<?>[] {trigger}, handler);
      manager.getClass().getMethod("addJobListener", job).invoke(manager, jobListener);
      try {
        manager
            .getClass()
            .getMethod("addTriggerListener", trigger)
            .invoke(manager, triggerListener);
      } catch (Exception exception) {
        call(manager, "removeJobListener", new Class<?>[] {String.class}, name);
        throw exception;
      }
      Registration registration = new Registration(manager, name);
      slot.registrations.add(registration);
      if (closed || profiles.mode(id) == MonitoringProfiles.Mode.BASIC || slots.get(id) != slot) {
        registration.remove();
        slot.registrations.remove(registration);
        return false;
      }
      return true;
    } catch (Exception ignored) {
      return false;
    }
  }

  private static boolean isType(Object value, String name) {
    try {
      return Class.forName(name, false, value.getClass().getClassLoader()).isInstance(value);
    } catch (ClassNotFoundException | LinkageError exception) {
      return false;
    }
  }

  private static Object call(Object target, String name) {
    return call(target, name, new Class<?>[0]);
  }

  private static Object call(
      Object target, String name, Class<?>[] parameters, Object... arguments) {
    if (target == null) return null;
    try {
      Method method = target.getClass().getMethod(name, parameters);
      return method.invoke(target, arguments);
    } catch (Exception | LinkageError exception) {
      return null;
    }
  }

  @Override
  public void close() {
    closed = true;
    workers.shutdownNow();
    for (Slot slot : slots.values()) detach(slot);
    slots.clear();
  }
}
