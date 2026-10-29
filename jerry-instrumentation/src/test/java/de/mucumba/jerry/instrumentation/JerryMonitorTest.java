package de.mucumba.jerry.instrumentation;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.reflect.Proxy;
import java.util.*;
import java.util.function.*;
import javax.jms.*;
import javax.servlet.ServletContext;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JerryMonitorTest {
  private static Object proxy(Class<?> api, java.lang.reflect.InvocationHandler handler) {
    return Proxy.newProxyInstance(api.getClassLoader(), new Class<?>[] {api}, handler);
  }

  @Test
  void jdbcMeasuresSuccessAndFailureWithoutSqlTextAndDelegatesTransactions() throws Exception {
    List<String> events = new ArrayList<>();
    Map<String, Object> bridge = new HashMap<>();
    bridge.put(
        "begin",
        (BiFunction<String, String, Object>)
            (category, operation) -> {
              events.add(category + ":" + operation);
              return new Object();
            });
    bridge.put(
        "complete",
        (BiConsumer<Object, Integer>) (ticket, status) -> events.add("status:" + status));
    ServletContext context =
        (ServletContext)
            proxy(
                ServletContext.class,
                (p, m, a) -> m.getName().equals("getAttribute") ? bridge : null);
    JdbcDataSource raw = new JdbcDataSource();
    raw.setURL("jdbc:h2:mem:instrumentation");
    DataSource source = JerryMonitor.dataSource(context, raw);
    try (java.sql.Connection connection = source.getConnection();
        java.sql.Statement statement = connection.createStatement()) {
      connection.setAutoCommit(false);
      try (java.sql.ResultSet result = statement.executeQuery("SELECT 1")) {
        assertTrue(result.next());
      }
      assertThrows(
          java.sql.SQLException.class, () -> statement.executeQuery("SELECT * FROM PRIVATE_NAME"));
      connection.rollback();
    }
    assertEquals(Arrays.asList("SQL:Query", "status:200", "SQL:Query", "status:500"), events);
  }

  @Test
  void jms2FluentProducerAndConsumerAreWrapped() {
    List<String> events = new ArrayList<>();
    Map<String, Object> bridge = new HashMap<>();
    bridge.put(
        "begin",
        (BiFunction<String, String, Object>)
            (category, operation) -> {
              events.add(category);
              return category;
            });
    bridge.put(
        "complete",
        (BiConsumer<Object, Integer>) (ticket, status) -> events.add(ticket + ":" + status));
    ServletContext context =
        (ServletContext)
            proxy(
                ServletContext.class,
                (p, m, a) -> m.getName().equals("getAttribute") ? bridge : null);
    JMSProducer producer =
        (JMSProducer)
            proxy(
                JMSProducer.class, (p, m, a) -> m.getReturnType() == JMSProducer.class ? p : null);
    JMSConsumer consumer = (JMSConsumer) proxy(JMSConsumer.class, (p, m, a) -> null);
    JMSContext jms =
        (JMSContext)
            proxy(
                JMSContext.class,
                (p, m, a) ->
                    m.getName().equals("createProducer")
                        ? producer
                        : m.getName().equals("createConsumer") ? consumer : null);
    ConnectionFactory factory =
        (ConnectionFactory)
            proxy(
                ConnectionFactory.class,
                (p, m, a) -> m.getName().equals("createContext") ? jms : null);
    JMSContext monitored = JerryMonitor.connectionFactory(context, factory).createContext();
    JMSProducer wrapped = monitored.createProducer();
    assertSame(wrapped, wrapped.setPriority(3));
    wrapped.send((Destination) null, "private");
    monitored.createConsumer(null).receiveNoWait();
    assertEquals(
        Arrays.asList("JMS_SEND", "JMS_SEND:200", "JMS_RECEIVE", "JMS_RECEIVE:200"), events);
  }
}
