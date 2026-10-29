package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.Config;
import de.mucumba.jerry.core.Json;
import de.mucumba.jerry.core.Workers;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import javax.management.*;
import org.apache.catalina.Context;

/** Explicit on-demand reads only; no invocation, writes, remote JMX or background polling. */
public final class ApplicationJmx implements AutoCloseable {
  private final MBeanServer server = ManagementFactory.getPlatformMBeanServer();
  private final Config config;
  private final ThreadPoolExecutor workers =
      new ThreadPoolExecutor(
          2,
          2,
          0,
          TimeUnit.MILLISECONDS,
          new ArrayBlockingQueue<Runnable>(8),
          new Workers("application-jmx"));

  public ApplicationJmx(Config config) {
    this.config = config;
  }

  public Map<String, Object> read(Context context, String encoded) throws Exception {
    if (!context.getState().isAvailable() || context.getLoader() == null)
      throw new IllegalStateException("Anwendung ist nicht gestartet.");
    Future<Map<String, Object>> future;
    try {
      future =
          workers.submit(
              () -> {
                ClassLoader previous = Thread.currentThread().getContextClassLoader();
                try {
                  Thread.currentThread()
                      .setContextClassLoader(context.getLoader().getClassLoader());
                  return collect(context, encoded);
                } finally {
                  Thread.currentThread().setContextClassLoader(previous);
                }
              });
    } catch (RejectedExecutionException exception) {
      throw new IllegalStateException("JMX-Lesewarteschlange belegt.");
    }
    try {
      return future.get(1500, TimeUnit.MILLISECONDS);
    } catch (TimeoutException exception) {
      future.cancel(true);
      workers.purge();
      throw new IllegalStateException(
          "JMX-Zeitbudget überschritten. Ein blockierender Getter kann bis zu seiner Rückkehr einen der zwei Lesearbeiter belegen.");
    } catch (ExecutionException exception) {
      Throwable cause = exception.getCause();
      if (cause instanceof Exception) throw (Exception) cause;
      throw new IllegalStateException("JMX-Abfrage fehlgeschlagen.");
    }
  }

  private Map<String, Object> collect(Context context, String encoded) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
    ClassLoader loader = context.getLoader().getClassLoader();
    List<ObjectName> rules = new ArrayList<>();
    List<String> warnings = new ArrayList<>();
    String configured = config.get("monitor.jmx." + TomcatAdapter.id(context) + ".patterns", "");
    String local = context.getServletContext().getInitParameter("jerry.jmx.patterns");
    if (local != null) configured += "|" + local;
    for (String value : configured.split("\\|"))
      if (!value.trim().isEmpty()) {
        if (rules.size() >= 16) {
          warnings.add("Maximal 16 Zuordnungsregeln.");
          break;
        }
        try {
          rules.add(new ObjectName(value.trim()));
        } catch (MalformedObjectNameException exception) {
          warnings.add("Ungültige JMX-Zuordnungsregel.");
        }
      }
    ObjectName selected = null;
    if (encoded != null) {
      try {
        selected =
            new ObjectName(
                new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8));
      } catch (Exception exception) {
        throw new IllegalArgumentException("Ungültige MBean-ID.");
      }
      if (selected.isPattern())
        throw new IllegalArgumentException("Eine konkrete MBean auswählen.");
      if (!server.isRegistered(selected) || association(context, loader, selected, rules) == null)
        throw new IllegalArgumentException("MBean gehört nicht zur ausgewählten Anwendung.");
    }
    List<Map<String, Object>> beans = new ArrayList<>(), attributes = new ArrayList<>();
    boolean truncated = false;
    if (selected != null) {
      MBeanInfo info = server.getMBeanInfo(selected);
      for (MBeanAttributeInfo attribute : info.getAttributes()) {
        if (attributes.size() >= 64
            || Thread.currentThread().isInterrupted()
            || System.nanoTime() > deadline) {
          truncated = true;
          break;
        }
        String name = attribute.getName(), state = "Nicht lesbar";
        Object value = null;
        if (sensitive(name)) state = "Geschützt (Getter nicht aufgerufen)";
        else if (attribute.isReadable() && simple(attribute.getType())) {
          try {
            Object read = server.getAttribute(selected, name);
            if (read == null
                || read instanceof String
                || read instanceof Number
                || read instanceof Boolean
                || read instanceof Character) {
              value =
                  read instanceof String && ((String) read).length() > 4096
                      ? ((String) read).substring(0, 4096) + " …"
                      : read;
              state = "Gelesen";
            } else state = "Komplexer Wert ausgelassen";
          } catch (Exception exception) {
            state = "Getter nicht verfügbar: " + exception.getClass().getSimpleName();
          }
        } else if (attribute.isReadable()) state = "Komplexer Typ ausgelassen";
        attributes.add(
            Json.map("name", name, "type", attribute.getType(), "value", value, "state", state));
      }
    } else {
      int inspected = 0;
      for (ObjectName name : server.queryNames(null, null)) {
        if (++inspected > 10000
            || beans.size() >= 200
            || Thread.currentThread().isInterrupted()
            || System.nanoTime() > deadline) {
          truncated = true;
          break;
        }
        try {
          String reason = association(context, loader, name, rules);
          if (reason == null) continue;
          MBeanInfo info = server.getMBeanInfo(name);
          beans.add(
              Json.map(
                  "id",
                  Base64.getUrlEncoder()
                      .withoutPadding()
                      .encodeToString(name.getCanonicalName().getBytes(StandardCharsets.UTF_8)),
                  "name",
                  name.getCanonicalName(),
                  "domain",
                  name.getDomain(),
                  "className",
                  info.getClassName(),
                  "association",
                  reason,
                  "attributes",
                  info.getAttributes().length,
                  "operations",
                  info.getOperations().length));
        } catch (InstanceNotFoundException ignored) {
          /* Concurrent undeployment. */
        }
      }
      beans.sort(Comparator.comparing(bean -> String.valueOf(bean.get("name"))));
    }
    return Json.map(
        "beans",
        beans,
        "selected",
        selected == null ? null : selected.getCanonicalName(),
        "attributes",
        attributes,
        "truncated",
        truncated,
        "warnings",
        warnings,
        "configKey",
        "monitor.jmx." + TomcatAdapter.id(context) + ".patterns",
        "rules",
        rules.toString());
  }

  private String association(
      Context context, ClassLoader loader, ObjectName name, List<ObjectName> rules)
      throws InstanceNotFoundException {
    if (server.getClassLoaderFor(name) == loader) return "Anwendungs-Classloader";
    String host = property(name, "host"), path = property(name, "context");
    if (path == null) path = property(name, "path");
    if (context.getParent().getName().equals(host)
        && path != null
        && (path.equals(context.getName()) || path.equals(context.getPath())))
      return "Host und Context";
    for (ObjectName rule : rules) if (rule.apply(name)) return "Explizite Zuordnungsregel";
    return null;
  }

  private static String property(ObjectName name, String key) {
    String value = name.getKeyProperty(key);
    if (value != null && value.startsWith("\""))
      try {
        return ObjectName.unquote(value);
      } catch (IllegalArgumentException ignored) {
      }
    return value;
  }

  private static boolean sensitive(String name) {
    String normalized = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    return normalized.matches(
        ".*(password|passwd|secret|token|credential|privatekey|apikey|accesskey|connectionstring|url).*");
  }

  private static boolean simple(String name) {
    return Arrays.asList(
            "boolean",
            "byte",
            "short",
            "int",
            "long",
            "float",
            "double",
            "char",
            "java.lang.Boolean",
            "java.lang.Byte",
            "java.lang.Short",
            "java.lang.Integer",
            "java.lang.Long",
            "java.lang.Float",
            "java.lang.Double",
            "java.lang.Character",
            "java.lang.String",
            "java.math.BigDecimal",
            "java.math.BigInteger")
        .contains(name);
  }

  @Override
  public void close() {
    workers.shutdownNow();
  }
}
