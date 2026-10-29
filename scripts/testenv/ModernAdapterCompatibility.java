package de.mucumba.jerry.testenv;

import de.mucumba.jerry.instrumentation.JerryHttpInterceptor;
import de.mucumba.jerry.instrumentation.JerryMonitor;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.BiFunction;
import javax.jms.ConnectionFactory;
import javax.jms.JMSConsumer;
import javax.jms.JMSContext;
import javax.jms.JMSProducer;
import javax.servlet.ServletContext;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpResponse;

/** Binary-compatibility probe compiled for Spring 5 and migrated to Jakarta for Spring 6. */
public final class ModernAdapterCompatibility {
  private static Object proxy(Class<?> type, java.lang.reflect.InvocationHandler handler) {
    return Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, handler);
  }

  public static void main(String[] args) throws Exception {
    List<String> events = new ArrayList<>();
    Map<String, Object> bridge = new HashMap<>();
    bridge.put("begin", (BiFunction<String, String, Object>) (category, operation) -> category);
    bridge.put(
        "complete",
        (BiConsumer<Object, Integer>) (ticket, status) -> events.add(ticket + ":" + status));
    ServletContext context =
        (ServletContext)
            proxy(
                ServletContext.class,
                (p, method, a) -> method.getName().equals("getAttribute") ? bridge : null);
    HttpRequest request =
        (HttpRequest)
            proxy(
                HttpRequest.class,
                (p, method, a) -> {
                  if (method.getName().equals("getMethod")) return HttpMethod.GET;
                  if (method.getName().equals("getURI"))
                    return URI.create("http://example.invalid/");
                  return null;
                });
    ClientHttpResponse response =
        (ClientHttpResponse)
            proxy(
                ClientHttpResponse.class,
                (p, method, a) -> {
                  if (method.getName().equals("getRawStatusCode")) return 503;
                  if (method.getName().equals("getStatusCode"))
                    return HttpStatus.SERVICE_UNAVAILABLE;
                  return null;
                });
    ClientHttpRequestExecution execution = (r, body) -> response;
    if (new JerryHttpInterceptor(context).intercept(request, new byte[0], execution) != response)
      throw new AssertionError("HTTP response was changed");

    JMSProducer producer =
        (JMSProducer)
            proxy(
                JMSProducer.class,
                (p, method, a) -> method.getReturnType() == JMSProducer.class ? p : null);
    JMSConsumer consumer = (JMSConsumer) proxy(JMSConsumer.class, (p, method, a) -> null);
    JMSContext jms =
        (JMSContext)
            proxy(
                JMSContext.class,
                (p, method, a) ->
                    method.getName().equals("createProducer")
                        ? producer
                        : method.getName().equals("createConsumer") ? consumer : null);
    ConnectionFactory factory =
        (ConnectionFactory)
            proxy(
                ConnectionFactory.class,
                (p, method, a) -> method.getName().equals("createContext") ? jms : null);
    JMSContext monitored = JerryMonitor.connectionFactory(context, factory).createContext();
    monitored.createProducer().send(null, "private fixture message");
    monitored.createConsumer(null).receiveNoWait();
    if (!events.contains("HTTP_OUTBOUND:503")
        || !events.contains("JMS_SEND:200")
        || !events.contains("JMS_RECEIVE:200"))
      throw new AssertionError("Missing events: " + events);
    System.out.println("PASS Spring 6.2 HTTP response and Jakarta JMS adapter compatibility");
  }
}
