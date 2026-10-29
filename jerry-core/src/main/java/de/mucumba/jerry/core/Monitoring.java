package de.mucumba.jerry.core;

import java.lang.management.BufferPoolMXBean;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadInfo;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.management.MBeanServer;
import javax.management.ObjectName;

/**
 * Samples JVM and Tomcat MBean counters and derives interval rates without inventing missing
 * values.
 */
public final class Monitoring {
  private final MBeanServer server = ManagementFactory.getPlatformMBeanServer();
  private final Map<String, Map<String, Object>> previous = new HashMap<>();
  private long previousTime;
  private final Map<String, String> connectorEpochs = new HashMap<>();

  public synchronized Map<String, Object> snapshot() {
    long now = System.currentTimeMillis();
    Map<String, Object> data =
        Json.map(
            "time",
            now,
            "uptime",
            ManagementFactory.getRuntimeMXBean().getUptime(),
            "processStarted",
            ManagementFactory.getRuntimeMXBean().getStartTime(),
            "heap",
            memory(ManagementFactory.getMemoryMXBean().getHeapMemoryUsage()),
            "nonHeap",
            memory(ManagementFactory.getMemoryMXBean().getNonHeapMemoryUsage()));
    List<Map<String, Object>> pools = new ArrayList<>(),
        collectors = new ArrayList<>(),
        buffers = new ArrayList<>();
    for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans())
      pools.add(
          Json.map(
              "name",
              pool.getName(),
              "type",
              pool.getType().toString(),
              "usage",
              memory(pool.getUsage()),
              "peak",
              memory(pool.getPeakUsage())));
    for (GarbageCollectorMXBean collector : ManagementFactory.getGarbageCollectorMXBeans())
      collectors.add(
          Json.map(
              "name",
              collector.getName(),
              "count",
              collector.getCollectionCount(),
              "time",
              collector.getCollectionTime()));
    for (BufferPoolMXBean pool : ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class))
      buffers.add(
          Json.map(
              "name",
              pool.getName(),
              "count",
              pool.getCount(),
              "used",
              pool.getMemoryUsed(),
              "capacity",
              pool.getTotalCapacity()));
    data.put("pools", pools);
    data.put(
        "sampleSeconds", previousTime == 0 ? null : Math.max(0, (now - previousTime) / 1000.0));
    data.put("gc", collectors);
    data.put("buffers", buffers);
    ThreadMXBean threads = ManagementFactory.getThreadMXBean();
    data.put(
        "threads",
        Json.map(
            "count",
            threads.getThreadCount(),
            "daemon",
            threads.getDaemonThreadCount(),
            "peak",
            threads.getPeakThreadCount(),
            "totalStarted",
            threads.getTotalStartedThreadCount()));
    java.lang.management.OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
    data.put(
        "os",
        Json.map(
            "name",
            os.getName(),
            "arch",
            os.getArch(),
            "version",
            os.getVersion(),
            "processors",
            os.getAvailableProcessors(),
            "loadAverage",
            available(os.getSystemLoadAverage()),
            "processCpu",
            osValue("getProcessCpuLoad"),
            "systemCpu",
            osValue("getSystemCpuLoad"),
            "physicalTotal",
            osValue("getTotalPhysicalMemorySize"),
            "physicalFree",
            osValue("getFreePhysicalMemorySize"),
            "swapTotal",
            osValue("getTotalSwapSpaceSize"),
            "swapFree",
            osValue("getFreeSwapSpaceSize"),
            "committedVirtual",
            osValue("getCommittedVirtualMemorySize")));
    List<Map<String, Object>> connectors =
        beans(
            "*:type=GlobalRequestProcessor,*",
            "requestCount",
            "errorCount",
            "bytesReceived",
            "bytesSent",
            "processingTime",
            "maxTime");
    for (Map<String, Object> connector : connectors) {
      String identity = String.valueOf(connector.get("objectName"));
      Map<String, Object> old = previous.get(identity);
      boolean reset = old == null;
      for (String counter : Arrays.asList("bytesReceived", "bytesSent", "requestCount")) {
        Object current = connector.get(counter), prior = old == null ? null : old.get(counter);
        if (current instanceof Number
            && prior instanceof Number
            && ((Number) current).longValue() < ((Number) prior).longValue()) reset = true;
      }
      if (reset) connectorEpochs.put(identity, java.util.UUID.randomUUID().toString());
      connector.put("counterEpoch", connectorEpochs.get(identity));
      double seconds = (now - previousTime) / 1000.0;
      for (String key :
          Arrays.asList(
              "requestCount", "errorCount", "bytesReceived", "bytesSent", "processingTime")) {
        Object value = connector.get(key), prior = old == null ? null : old.get(key);
        Double delta =
            !reset
                    && value instanceof Number
                    && prior instanceof Number
                    && ((Number) value).longValue() >= ((Number) prior).longValue()
                ? ((Number) value).doubleValue() - ((Number) prior).doubleValue()
                : null;
        connector.put(key + "Rate", delta != null && seconds > 0 ? delta / seconds : null);
      }
      Object requestRate = connector.get("requestCountRate"),
          timeRate = connector.get("processingTimeRate");
      connector.put(
          "averageMs",
          requestRate instanceof Number
                  && ((Number) requestRate).doubleValue() > 0
                  && timeRate instanceof Number
              ? ((Number) timeRate).doubleValue() / ((Number) requestRate).doubleValue()
              : null);
    }
    previous.clear();
    java.util.Set<String> liveConnectors = new java.util.HashSet<>();
    for (Map<String, Object> connector : connectors) {
      String key = String.valueOf(connector.get("objectName"));
      previous.put(key, connector);
      liveConnectors.add(key);
    }
    connectorEpochs.keySet().retainAll(liveConnectors);
    previousTime = now;
    data.put("connectors", connectors);
    data.put(
        "threadPools",
        beans(
            "*:type=ThreadPool,*",
            "currentThreadCount",
            "currentThreadsBusy",
            "maxThreads",
            "connectionCount",
            "maxConnections",
            "keepAliveCount"));
    data.put(
        "executors",
        beans(
            "*:type=Executor,*",
            "activeCount",
            "poolSize",
            "maxThreads",
            "queueSize",
            "completedTaskCount"));
    return data;
  }

  private static Object available(double value) {
    return value < 0 || Double.isNaN(value) ? null : value;
  }

  private Object osValue(String method) {
    try {
      java.lang.reflect.Method getter =
          Class.forName("com.sun.management.OperatingSystemMXBean").getMethod(method);
      Object value = getter.invoke(ManagementFactory.getOperatingSystemMXBean());
      return value instanceof Number && ((Number) value).doubleValue() < 0 ? null : value;
    } catch (ReflectiveOperationException | RuntimeException ignored) {
      return null;
    }
  }

  private static Map<String, Object> memory(MemoryUsage usage) {
    return usage == null
        ? null
        : Json.map(
            "used",
            usage.getUsed(),
            "committed",
            usage.getCommitted(),
            "max",
            usage.getMax() < 0 ? null : usage.getMax(),
            "init",
            usage.getInit());
  }

  public List<Map<String, Object>> beans(String pattern, String... attributes) {
    List<Map<String, Object>> result = new ArrayList<>();
    try {
      Set<ObjectName> names = server.queryNames(new ObjectName(pattern), null);
      for (ObjectName name : names) {
        Map<String, Object> bean =
            Json.map("objectName", name.toString(), "name", unquote(name.getKeyProperty("name")));
        for (String attribute : attributes) {
          try {
            Object value = server.getAttribute(name, attribute);
            bean.put(
                attribute,
                value instanceof Number || value instanceof Boolean || value instanceof String
                    ? value
                    : value == null ? null : String.valueOf(value));
          } catch (Exception ignored) {
            bean.put(attribute, null);
          }
        }
        result.add(bean);
        if (result.size() >= 10000) break;
      }
    } catch (Exception ignored) {
    }
    result.sort(
        (a, b) ->
            String.valueOf(a.get("objectName")).compareTo(String.valueOf(b.get("objectName"))));
    return result;
  }

  private static String unquote(String text) {
    return text == null ? "" : text.startsWith("\"") ? ObjectName.unquote(text) : text;
  }

  public List<Map<String, Object>> processors() {
    return beans(
        "*:type=RequestProcessor,*",
        "stage",
        "workerThreadName",
        "currentUri",
        "method",
        "remoteAddr",
        "requestProcessingTime",
        "requestBytesReceived",
        "requestBytesSent",
        "requestCount",
        "errorCount");
  }

  public List<Map<String, Object>> clusterBeans() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (String pattern : Arrays.asList("*:type=Cluster*,*", "*:type=Channel,*"))
      try {
        for (ObjectName name : server.queryNames(new ObjectName(pattern), null)) {
          Map<String, Object> row =
              Json.map("objectName", name.toString(), "name", name.getKeyProperty("type"));
          for (javax.management.MBeanAttributeInfo info :
              server.getMBeanInfo(name).getAttributes()) {
            if (!info.isReadable()) continue;
            try {
              Object value = server.getAttribute(name, info.getName());
              if (value instanceof Number || value instanceof Boolean)
                row.put(info.getName(), value);
            } catch (Exception ignored) {
            }
            if (row.size() >= 100) break;
          }
          result.add(row);
          if (result.size() >= 500) return result;
        }
      } catch (Exception ignored) {
      }
    return result;
  }

  public List<Map<String, Object>> threads(boolean stacks) {
    ThreadMXBean bean = ManagementFactory.getThreadMXBean();
    long[] deadlocks =
        bean.isSynchronizerUsageSupported()
            ? bean.findDeadlockedThreads()
            : bean.findMonitorDeadlockedThreads();
    List<Map<String, Object>> result = new ArrayList<>();
    for (ThreadInfo info : bean.getThreadInfo(bean.getAllThreadIds(), stacks ? 100 : 0)) {
      if (info == null) continue;
      boolean deadlocked = false;
      if (deadlocks != null)
        for (long id : deadlocks) if (id == info.getThreadId()) deadlocked = true;
      long cpu = -1;
      if (bean.isThreadCpuTimeSupported() && bean.isThreadCpuTimeEnabled())
        cpu = bean.getThreadCpuTime(info.getThreadId());
      List<String> stack = new ArrayList<>();
      for (StackTraceElement frame : info.getStackTrace()) stack.add(frame.toString());
      result.add(
          Json.map(
              "id",
              info.getThreadId(),
              "name",
              info.getThreadName(),
              "state",
              info.getThreadState().toString(),
              "blockedCount",
              info.getBlockedCount(),
              "waitedCount",
              info.getWaitedCount(),
              "lock",
              info.getLockName(),
              "lockOwner",
              info.getLockOwnerName(),
              "cpuNanos",
              cpu < 0 ? null : cpu,
              "deadlocked",
              deadlocked,
              "stack",
              stack));
    }
    result.sort((a, b) -> String.valueOf(a.get("name")).compareTo(String.valueOf(b.get("name"))));
    return result;
  }

  @SuppressWarnings("deprecation")
  public void threadAction(long id, boolean force) {
    for (Thread thread : Thread.getAllStackTraces().keySet())
      if (thread.getId() == id) {
        if (thread == Thread.currentThread() || thread.getName().startsWith("Jerry-"))
          throw new IllegalArgumentException(
              "Eigene Verwaltungsthreads können nicht beendet werden.");
        if (force) thread.stop();
        else thread.interrupt();
        return;
      }
    throw new IllegalArgumentException("Thread existiert nicht mehr.");
  }

  public Map<String, Object> system(boolean sensitive) {
    Map<String, Object> properties = new LinkedHashMap<>();
    if (sensitive)
      for (Map.Entry<Object, Object> entry : System.getProperties().entrySet()) {
        String key = String.valueOf(entry.getKey());
        properties.put(
            key,
            key.toLowerCase(java.util.Locale.ROOT)
                    .matches(".*(password|passwd|secret|token|credential|privatekey).*")
                ? "••••••"
                : String.valueOf(entry.getValue()));
      }
    return Json.map(
        "javaVersion",
        System.getProperty("java.version"),
        "javaVendor",
        System.getProperty("java.vendor"),
        "vmName",
        System.getProperty("java.vm.name"),
        "started",
        ManagementFactory.getRuntimeMXBean().getStartTime(),
        "properties",
        properties,
        "classLoading",
        Json.map(
            "loaded",
            ManagementFactory.getClassLoadingMXBean().getLoadedClassCount(),
            "total",
            ManagementFactory.getClassLoadingMXBean().getTotalLoadedClassCount(),
            "unloaded",
            ManagementFactory.getClassLoadingMXBean().getUnloadedClassCount()));
  }
}
