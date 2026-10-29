package de.mucumba.jerry.instrumentation;

import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.util.function.BiConsumer;
import java.util.function.BiFunction;
import javax.jms.ConnectionFactory;
import javax.servlet.ServletContext;
import javax.sql.DataSource;

/**
 * Optional, application-local adapters. No network calls and no SQL, URL or message payloads are
 * recorded.
 */
public final class JerryMonitor {
  public static final String BRIDGE_ATTRIBUTE = "de.mucumba.jerry.monitor.bridge.v1";

  private JerryMonitor() {}

  public static final class Scope implements AutoCloseable {
    private final Object ticket;
    private final BiConsumer<Object, Integer> complete;
    private boolean finished;

    Scope(Object ticket, BiConsumer<Object, Integer> complete) {
      this.ticket = ticket;
      this.complete = complete;
    }

    public void finish(int status) {
      if (finished) return;
      finished = true;
      if (ticket != null && complete != null)
        try {
          complete.accept(ticket, status);
        } catch (RuntimeException | LinkageError ignored) {
        }
    }

    public void failed() {
      finish(500);
    }

    @Override
    public void close() {
      finish(200);
    }
  }

  @SuppressWarnings("unchecked")
  /**
   * Begins a no-op scope when the bridge is unavailable or the application uses basic monitoring.
   */
  public static Scope begin(ServletContext context, String category, String operation) {
    try {
      Object value = context == null ? null : context.getAttribute(BRIDGE_ATTRIBUTE);
      if (!(value instanceof Map)) return new Scope(null, null);
      Map<?, ?> bridge = (Map<?, ?>) value;
      Object start = bridge.get("begin"), end = bridge.get("complete");
      if (!(start instanceof BiFunction) || !(end instanceof BiConsumer))
        return new Scope(null, null);
      Object ticket = ((BiFunction<String, String, Object>) start).apply(category, operation);
      return new Scope(ticket, (BiConsumer<Object, Integer>) end);
    } catch (RuntimeException | LinkageError ignored) {
      return new Scope(null, null);
    }
  }

  /**
   * Wrap an existing DataSource; it is never opened until the application asks for a connection.
   */
  public static DataSource dataSource(ServletContext context, DataSource source) {
    Objects.requireNonNull(source, "source");
    return (DataSource)
        Proxy.newProxyInstance(
            JerryMonitor.class.getClassLoader(),
            new Class<?>[] {DataSource.class},
            (proxy, method, args) -> {
              Object result = invoke(source, method, args);
              if (result instanceof Connection && method.getName().equals("getConnection"))
                return connection(context, (Connection) result);
              return result;
            });
  }

  private static Connection connection(ServletContext context, Connection target) {
    final Object[] reference = new Object[1];
    reference[0] =
        Proxy.newProxyInstance(
            JerryMonitor.class.getClassLoader(),
            new Class<?>[] {Connection.class},
            (proxy, method, args) -> {
              Object value = invoke(target, method, args);
              if (value instanceof Statement
                  && (method.getName().equals("createStatement")
                      || method.getName().equals("prepareStatement")
                      || method.getName().equals("prepareCall")))
                return statement(context, (Statement) value, (Connection) reference[0]);
              return value;
            });
    return (Connection) reference[0];
  }

  private static Statement statement(
      ServletContext context, Statement target, Connection connection) {
    Class<?> api =
        target instanceof CallableStatement
            ? CallableStatement.class
            : target instanceof PreparedStatement ? PreparedStatement.class : Statement.class;
    return (Statement)
        Proxy.newProxyInstance(
            JerryMonitor.class.getClassLoader(),
            new Class<?>[] {api},
            (proxy, method, args) -> {
              String name = method.getName();
              if (name.equals("getConnection")) return connection;
              if (!name.startsWith("execute")) return invoke(target, method, args);
              String operation =
                  name.toLowerCase(Locale.ROOT).contains("batch")
                      ? "Batch"
                      : name.toLowerCase(Locale.ROOT).contains("query")
                          ? "Query"
                          : name.toLowerCase(Locale.ROOT).contains("update") ? "Update" : "Execute";
              Scope scope = begin(context, "SQL", operation);
              try {
                Object result = invoke(target, method, args);
                scope.close();
                return result;
              } catch (Throwable exception) {
                scope.failed();
                throw exception;
              }
            });
  }

  /** Wrap an existing JMS client factory. Supports standard JMS 1.1 and JMS 2.0 interfaces. */
  public static ConnectionFactory connectionFactory(
      ServletContext context, ConnectionFactory source) {
    Objects.requireNonNull(source, "source");
    return (ConnectionFactory) jmsProxy(context, source);
  }

  private static boolean isType(Object target, String type) {
    try {
      return Class.forName(type, false, JerryMonitor.class.getClassLoader()).isInstance(target);
    } catch (ClassNotFoundException | LinkageError ignored) {
      return false;
    }
  }

  private static void interfaces(Class<?> type, Set<Class<?>> result) {
    if (type == null) return;
    for (Class<?> item : type.getInterfaces()) {
      if (item.getName().startsWith("javax.jms.") && Modifier.isPublic(item.getModifiers()))
        result.add(item);
      interfaces(item, result);
    }
    interfaces(type.getSuperclass(), result);
  }

  private static boolean jmsObject(Object value) {
    if (value == null) return false;
    for (String type :
        Arrays.asList(
            "javax.jms.ConnectionFactory",
            "javax.jms.Connection",
            "javax.jms.Session",
            "javax.jms.MessageProducer",
            "javax.jms.MessageConsumer",
            "javax.jms.JMSContext",
            "javax.jms.JMSProducer",
            "javax.jms.JMSConsumer")) if (isType(value, type)) return true;
    return false;
  }

  private static Object jmsProxy(ServletContext context, Object target) {
    Set<Class<?>> apis = new LinkedHashSet<>();
    interfaces(target.getClass(), apis);
    if (apis.isEmpty()) return target;
    final boolean producer =
        isType(target, "javax.jms.MessageProducer") || isType(target, "javax.jms.JMSProducer");
    final boolean consumer =
        isType(target, "javax.jms.MessageConsumer") || isType(target, "javax.jms.JMSConsumer");
    return Proxy.newProxyInstance(
        JerryMonitor.class.getClassLoader(),
        apis.toArray(new Class<?>[0]),
        new InvocationHandler() {
          Object originalListener;

          @Override
          public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            String name = method.getName();
            if (consumer && name.equals("getMessageListener") && originalListener != null)
              return originalListener;
            if (consumer && name.equals("setMessageListener") && args != null && args.length == 1) {
              originalListener = args[0];
              Object[] replacement = args.clone();
              if (args[0] != null)
                replacement[0] = listener(context, args[0], method.getParameterTypes()[0]);
              return JerryMonitor.invoke(target, method, replacement);
            }
            boolean measured =
                producer && (name.equals("send") || name.equals("publish"))
                    || consumer && name.startsWith("receive");
            Scope scope =
                measured
                    ? begin(
                        context,
                        producer ? "JMS_SEND" : "JMS_RECEIVE",
                        producer ? "Senden" : "Empfangen")
                    : null;
            try {
              Object result = JerryMonitor.invoke(target, method, args);
              if (scope != null) scope.close();
              if (result == target) return proxy; // Preserve JMS 2 fluent producer chains.
              return jmsObject(result) ? jmsProxy(context, result) : result;
            } catch (Throwable exception) {
              if (scope != null) scope.failed();
              throw exception;
            }
          }
        });
  }

  private static Object listener(ServletContext context, Object target, Class<?> api) {
    return Proxy.newProxyInstance(
        JerryMonitor.class.getClassLoader(),
        new Class<?>[] {api},
        (proxy, method, args) -> {
          if (!method.getName().equals("onMessage")) return invoke(target, method, args);
          Scope scope = begin(context, "JMS_RECEIVE", "Listener");
          try {
            Object result = invoke(target, method, args);
            scope.close();
            return result;
          } catch (Throwable exception) {
            scope.failed();
            throw exception;
          }
        });
  }

  private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
    try {
      return method.invoke(target, args);
    } catch (InvocationTargetException exception) {
      throw exception.getCause();
    }
  }
}
