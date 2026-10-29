package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.lang.management.ManagementFactory;
import java.util.List;
import java.util.Map;
import javax.management.*;
import org.junit.jupiter.api.Test;

class MonitoringTest {
  public static final class Counters implements DynamicMBean {
    long received = 10, sent = 20, requests = 1;

    public Object getAttribute(String name) throws AttributeNotFoundException {
      switch (name) {
        case "bytesReceived":
          return received;
        case "bytesSent":
          return sent;
        case "requestCount":
          return requests;
        default:
          throw new AttributeNotFoundException(name);
      }
    }

    public AttributeList getAttributes(String[] names) {
      AttributeList result = new AttributeList();
      for (String name : names)
        try {
          result.add(new Attribute(name, getAttribute(name)));
        } catch (Exception ignored) {
        }
      return result;
    }

    public void setAttribute(Attribute attribute) throws AttributeNotFoundException {
      throw new AttributeNotFoundException();
    }

    public AttributeList setAttributes(AttributeList attributes) {
      return new AttributeList();
    }

    public Object invoke(String action, Object[] args, String[] signature) {
      throw new UnsupportedOperationException();
    }

    public MBeanInfo getMBeanInfo() {
      return new MBeanInfo(
          getClass().getName(),
          "Tomcat-style lowercase counters",
          new MBeanAttributeInfo[] {
            new MBeanAttributeInfo("bytesReceived", "long", "Received", true, false, false),
            new MBeanAttributeInfo("bytesSent", "long", "Sent", true, false, false),
            new MBeanAttributeInfo("requestCount", "long", "Requests", true, false, false)
          },
          null,
          null,
          null);
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> connector(Monitoring monitoring, ObjectName name) {
    return ((List<Map<String, Object>>) monitoring.snapshot().get("connectors"))
        .stream().filter(row -> name.toString().equals(row.get("objectName"))).findFirst().get();
  }

  @Test
  void resetEpochsAreStableUntilResetOrRemoval() throws Exception {
    MBeanServer server = ManagementFactory.getPlatformMBeanServer();
    ObjectName name = new ObjectName("JerryTest:type=GlobalRequestProcessor,name=traffic");
    Counters counters = new Counters();
    server.registerMBean(counters, name);
    try {
      Monitoring monitoring = new Monitoring();
      Map<String, Object> first = connector(monitoring, name);
      assertEquals(10L, first.get("bytesReceived"));
      counters.received += 20;
      counters.sent += 40;
      counters.requests++;
      Map<String, Object> second = connector(monitoring, name);
      assertEquals(first.get("counterEpoch"), second.get("counterEpoch"));
      counters.requests =
          0; // Reset one counter while byte counters are larger: all rates must become unknown.
      Map<String, Object> reset = connector(monitoring, name);
      assertNotEquals(second.get("counterEpoch"), reset.get("counterEpoch"));
      assertNull(reset.get("bytesSentRate"));
      server.unregisterMBean(name);
      monitoring.snapshot();
      server.registerMBean(counters, name);
      assertNotEquals(reset.get("counterEpoch"), connector(monitoring, name).get("counterEpoch"));
    } finally {
      if (server.isRegistered(name)) server.unregisterMBean(name);
    }
  }
}
