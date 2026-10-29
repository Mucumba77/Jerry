package de.mucumba.jerry.instrumentation;

import java.io.IOException;
import java.lang.reflect.Method;
import javax.servlet.ServletContext;
import org.springframework.http.HttpRequest;
import org.springframework.http.client.ClientHttpRequestExecution;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.ClientHttpResponse;

/** Optional Spring RestTemplate interceptor; measures until response headers arrive. */
public final class JerryHttpInterceptor implements ClientHttpRequestInterceptor {
  private static final Method RAW_STATUS = find(ClientHttpResponse.class, "getRawStatusCode");
  private static final Method STATUS = find(ClientHttpResponse.class, "getStatusCode");
  private static final Method STATUS_VALUE =
      STATUS == null ? null : find(STATUS.getReturnType(), "value");
  private final ServletContext context;

  public JerryHttpInterceptor(ServletContext context) {
    this.context = context;
  }

  @Override
  public ClientHttpResponse intercept(
      HttpRequest request, byte[] body, ClientHttpRequestExecution execution) throws IOException {
    JerryMonitor.Scope scope =
        JerryMonitor.begin(context, "HTTP_OUTBOUND", String.valueOf(request.getMethod()));
    try {
      ClientHttpResponse response = execution.execute(request, body);
      scope.finish(status(response));
      return response;
    } catch (IOException | RuntimeException exception) {
      scope.failed();
      throw exception;
    }
  }

  /** Resolve methods through the public API to support both Spring 5 and Spring 6.2+. */
  private static Method find(Class<?> api, String name) {
    try {
      return api.getMethod(name);
    } catch (NoSuchMethodException ignored) {
      return null;
    }
  }

  private static int status(ClientHttpResponse response) {
    try {
      if (RAW_STATUS != null) return ((Number) RAW_STATUS.invoke(response)).intValue();
      if (STATUS != null && STATUS_VALUE != null) {
        Object code = STATUS.invoke(response);
        return ((Number) STATUS_VALUE.invoke(code)).intValue();
      }
    } catch (ReflectiveOperationException | RuntimeException ignored) {
      // The monitoring adapter must never change the result of an application's HTTP call.
    }
    return 200;
  }
}
