package de.mucumba.jerry.web;

import com.fasterxml.jackson.core.type.TypeReference;
import de.mucumba.jerry.core.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import javax.servlet.ServletConfig;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;
import org.apache.catalina.ContainerServlet;
import org.apache.catalina.Wrapper;

/** Routes authenticated Jerry API requests and enforces role and CSRF checks on state changes. */
public final class JerryServlet extends HttpServlet implements ContainerServlet {
  private static final long serialVersionUID = 1L;
  private transient Wrapper wrapper;
  private transient JerryRuntime runtime;

  @Override
  public Wrapper getWrapper() {
    return wrapper;
  }

  @Override
  public void setWrapper(Wrapper wrapper) {
    this.wrapper = wrapper;
  }

  @Override
  public void init(ServletConfig config) throws ServletException {
    super.init(config);
    try {
      runtime = new JerryRuntime(wrapper);
      getServletContext().setAttribute(JerryRuntime.KEY, runtime);
    } catch (Exception exception) {
      throw new ServletException(
          "Jerry konnte nicht initialisiert werden: " + exception.getMessage(), exception);
    }
  }

  private boolean admin(HttpServletRequest request) {
    return request.isUserInRole("jerry-admin");
  }

  private boolean operator(HttpServletRequest request) {
    return admin(request) || request.isUserInRole("jerry-operator");
  }

  private boolean sql(HttpServletRequest request) {
    return admin(request)
        || request.isUserInRole("jerry-sql")
        || request.isUserInRole("jerry-sql-read");
  }

  private void require(boolean allowed) {
    if (!allowed) throw new SecurityException("Die erforderliche Berechtigung fehlt.");
  }

  private String owner(HttpServletRequest request) {
    return request.getSession().getId();
  }

  private String user(HttpServletRequest request) {
    return request.getUserPrincipal() == null ? "" : request.getUserPrincipal().getName();
  }

  private String csrf(HttpServletRequest request) {
    HttpSession session = request.getSession();
    synchronized (session) {
      String token = (String) session.getAttribute("jerry.csrf");
      if (token == null) {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        session.setAttribute("jerry.csrf", token);
      }
      return token;
    }
  }

  @Override
  protected void service(HttpServletRequest request, HttpServletResponse response)
      throws ServletException, IOException {
    if (request.getUserPrincipal() == null) {
      error(response, 401, "Bitte erneut anmelden.");
      return;
    }
    if (!(request.isUserInRole("jerry-viewer") || operator(request) || sql(request))) {
      error(response, 403, "Keine Jerry-Rolle zugewiesen.");
      return;
    }
    if (runtime.config.bool("https.required", false) && !request.isSecure()) {
      error(response, 403, "Jerry erfordert eine HTTPS-Verbindung.");
      return;
    }
    response.setContentType("application/json;charset=UTF-8");
    try {
      String method = request.getMethod();
      if (!"GET".equals(method)) {
        if (!"POST".equals(method) && !"DELETE".equals(method)) {
          error(response, 405, "HTTP-Methode nicht unterstützt.");
          return;
        }
        String token = request.getHeader("X-CSRF-Token");
        if (token == null
            || !MessageDigest.isEqual(
                token.getBytes(StandardCharsets.UTF_8),
                csrf(request).getBytes(StandardCharsets.UTF_8)))
          throw new SecurityException("Sitzungstoken fehlt oder ist ungültig. Seite neu laden.");
      }
      String path = request.getPathInfo();
      if (path == null) path = "/";
      if ("GET".equals(method)) get(path, request, response);
      else change(path, request, response);
    } catch (SecurityException exception) {
      if (!response.isCommitted()) error(response, 403, exception.getMessage());
    } catch (IllegalArgumentException exception) {
      if (!response.isCommitted()) error(response, 400, exception.getMessage());
    } catch (IllegalStateException exception) {
      if (!response.isCommitted()) error(response, 409, exception.getMessage());
    } catch (java.sql.SQLException exception) {
      if (!response.isCommitted()) {
        response.setStatus(422);
        send(
            response,
            Json.map(
                "error",
                exception.getMessage(),
                "sqlState",
                exception.getSQLState(),
                "vendorCode",
                exception.getErrorCode()));
      }
    } catch (Exception exception) {
      getServletContext().log("Jerry request failed: " + request.getPathInfo(), exception);
      if (!response.isCommitted())
        error(
            response,
            500,
            exception.getMessage() == null
                ? "Die Aktion ist fehlgeschlagen."
                : exception.getMessage());
    }
  }

  private void get(String path, HttpServletRequest request, HttpServletResponse response)
      throws Exception {
    String[] parts = path.substring(1).split("/");
    switch (path) {
      case "/me":
        send(
            response,
            Json.map(
                "name",
                "Jerry",
                "version",
                "2.1.0",
                "user",
                user(request),
                "csrf",
                csrf(request),
                "server",
                runtime.tomcat.info(),
                "permissions",
                Json.map(
                    "admin",
                    admin(request),
                    "operator",
                    operator(request),
                    "sql",
                    sql(request),
                    "sqlWrite",
                    admin(request) || request.isUserInRole("jerry-sql")),
                "settings",
                Json.map(
                    "forceThreadStop",
                    runtime.config.bool("threads.forceStop.enabled", false),
                    "wrapperRestart",
                    runtime.config.bool("wrapper.restart.enabled", false),
                    "monitorInterval",
                    runtime.config.number("monitor.interval.seconds", 10, 1, 60))));
        return;
      case "/summary":
        send(response, runtime.latest);
        return;
      case "/alerts":
        send(response, runtime.alerts.snapshot());
        return;
      case "/events":
        if (runtime.streams.size() >= 64)
          throw new IllegalStateException("Zu viele Live-Verbindungen.");
        response.setContentType("text/event-stream;charset=UTF-8");
        response.setHeader("X-Accel-Buffering", "no");
        EventStream stream = new EventStream(owner(request), runtime, request.startAsync());
        runtime.streams.add(stream);
        stream.offer(runtime.latest);
        return;
      case "/history":
        long to = number(request, "to", System.currentTimeMillis(), 0, Long.MAX_VALUE),
            from = number(request, "from", to - 3600000, 0, to);
        send(
            response,
            runtime.metrics.query(from, to, (int) number(request, "points", 500, 10, 2000)));
        return;
      case "/applications":
        List<Map<String, Object>> applications = runtime.tomcat.applications();
        for (Map<String, Object> app : applications)
          app.put("monitoring", runtime.profiles.state(String.valueOf(app.get("id"))));
        send(response, applications);
        return;
      case "/hosts":
        send(response, runtime.tomcat.hosts());
        return;
      case "/deployments":
        require(admin(request));
        send(response, runtime.tomcat.deploymentDescriptors());
        return;
      case "/processors":
        send(response, runtime.monitoring.processors());
        return;
      case "/connectors":
        send(response, runtime.tomcat.connectors());
        return;
      case "/threads":
        send(response, runtime.monitoring.threads("true".equals(request.getParameter("stacks"))));
        return;
      case "/system":
        send(response, runtime.monitoring.system(admin(request)));
        return;
      case "/cluster":
        send(
            response,
            Json.map(
                "status",
                runtime.tomcat.cluster(),
                "channels",
                runtime.monitoring.clusterBeans(),
                "replication",
                runtime.latest.get("clusterReplication"),
                "managers",
                runtime.monitoring.beans(
                    "*:type=Manager,*",
                    "activeSessions",
                    "sessionCounter",
                    "expiredSessions",
                    "sessionMaxAliveTime",
                    "processingTime")));
        return;
      case "/certificates":
        require(admin(request));
        send(response, runtime.tomcat.certificates());
        return;
      case "/wrapper":
        send(response, runtime.tomcat.wrapperStatus());
        return;
      case "/datasources":
        List<Map<String, Object>> sources = runtime.tomcat.list();
        if ("true".equals(request.getParameter("metrics"))) {
          for (Map<String, Object> source : sources) {
            try {
              source.put("pool", runtime.tomcat.pool(String.valueOf(source.get("id"))));
            } catch (Exception exception) {
              source.put("poolError", "Poolmetriken sind momentan nicht verfügbar.");
            }
          }
        }
        send(response, sources);
        return;
      case "/sql":
        require(sql(request));
        send(response, runtime.sql.list(owner(request)));
        return;
      case "/logs":
        send(response, runtime.logs.files());
        return;
      case "/loggers":
        require(admin(request));
        send(response, runtime.tomcat.loggers(request.getParameter("app")));
        return;
      case "/preferences":
        require(sql(request));
        send(response, runtime.users.load(user(request)));
        return;
      case "/diagnostics":
        require(admin(request));
        send(
            response,
            Json.map(
                "sql",
                runtime.sql.diagnostics(),
                "telemetry",
                runtime.telemetry.diagnostics(),
                "applicationCollectors",
                runtime.applications.diagnostics(),
                "liveClients",
                runtime.streams.size(),
                "collectionError",
                runtime.collectionError,
                "dataDirectory",
                runtime.config.dataDirectory.toString(),
                "configFile",
                runtime.config.configurationFile.toString()));
        return;
      default:
        break;
    }
    if (parts.length >= 2 && "applications".equals(parts[0])) {
      String app = parts[1];
      if (parts.length == 3 && "jmx".equals(parts[2])) {
        require(admin(request));
        send(response, runtime.jmx.read(runtime.tomcat.context(app), request.getParameter("bean")));
        return;
      }
      if (parts.length == 3 && "monitoring".equals(parts[2])) {
        require(operator(request));
        runtime.tomcat.context(app);
        send(response, applicationMonitoring(app));
        return;
      }
      if (parts.length == 2) {
        require(operator(request));
        Map<String, Object> details = runtime.tomcat.details(app, admin(request));
        if (!admin(request)) {
          details.remove("contextXml");
          details.remove("webXml");
        }
        send(response, details);
        return;
      }
      if ("sessions".equals(parts[2])) {
        require(operator(request));
        send(
            response,
            runtime.tomcat.sessions(
                app,
                request.getParameter("q"),
                admin(request) && "true".equals(request.getParameter("estimate")),
                request.getParameter("session")));
        return;
      }
      if ("jsps".equals(parts[2])) {
        require(operator(request));
        if (request.getParameter("path") != null)
          send(response, runtime.tomcat.jspSource(app, request.getParameter("path")));
        else send(response, runtime.tomcat.jsps(app));
        return;
      }
    }
    if (parts.length >= 2 && "datasources".equals(parts[0])) {
      send(response, runtime.tomcat.pool(parts[1]));
      return;
    }
    if (parts.length >= 2 && "sql".equals(parts[0])) {
      require(sql(request));
      String id = parts[1];
      if (parts.length == 2) {
        send(
            response,
            runtime.sql.status(
                owner(request), id, !"false".equals(request.getParameter("preview"))));
        return;
      }
      if ("metadata".equals(parts[2])) {
        send(
            response,
            runtime.sql.metadata(
                owner(request),
                id,
                request.getParameter("schema"),
                request.getParameter("table"),
                "true".equals(request.getParameter("columnsOnly"))));
        return;
      }
      if ("results".equals(parts[2]) && parts.length >= 4) {
        if (parts.length == 5 && "csv".equals(parts[4])) {
          Map<String, Object> options = Json.map();
          for (String key :
              Arrays.asList(
                  "separator",
                  "encoding",
                  "bom",
                  "null",
                  "safe",
                  "header",
                  "scope",
                  "datePattern",
                  "timestampPattern"))
            if (request.getParameter(key) != null) options.put(key, request.getParameter(key));
          String encoding = Json.text(options, "encoding", "UTF-8");
          response.setContentType("text/csv;charset=" + encoding);
          response.setHeader("Content-Disposition", "attachment; filename=\"jerry-result.csv\"");
          runtime.sql.export(owner(request), id, parts[3], response.getOutputStream(), options);
          return;
        }
        send(
            response,
            runtime.sql.page(
                owner(request),
                id,
                parts[3],
                (int) number(request, "offset", 0, 0, 10000000),
                (int) number(request, "limit", 200, 1, 1000)));
        return;
      }
    }
    if (parts.length >= 2 && "logs".equals(parts[0])) {
      if (parts.length >= 3 && "search".equals(parts[1])) {
        send(response, runtime.logs.searchStatus(owner(request), parts[2]));
        return;
      }
      String id = parts[1];
      if (parts.length == 3 && "download".equals(parts[2])) {
        String name = runtime.logs.filename(id).replaceAll("[^A-Za-z0-9._-]", "_");
        response.setContentType("application/octet-stream");
        response.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
        runtime.logs.download(user(request), id, response.getOutputStream());
        return;
      }
      send(
          response,
          runtime.logs.read(
              id,
              number(request, "cursor", -1, -1, Long.MAX_VALUE),
              (int) number(request, "limit", 300, 1, 2000),
              parameter(request, "encoding", "UTF-8"),
              request.getParameter("identity"),
              request.getParameter("direction")));
      return;
    }
    error(response, 404, "API-Endpunkt nicht gefunden.");
  }

  private void change(String path, HttpServletRequest request, HttpServletResponse response)
      throws Exception {
    String[] parts = path.substring(1).split("/");
    String user = user(request);
    if ("/deploy".equals(path)) {
      require(admin(request));
      Map<String, Object> result;
      try {
        result =
            runtime.tomcat.deploy(
                parameter(request, "host", "localhost"),
                parameter(request, "path", ""),
                parameter(request, "version", ""),
                request.getInputStream());
        runtime.audit.event(user, "application.deploy", parameter(request, "path", ""), "OK");
      } catch (Exception exception) {
        runtime.audit.event(user, "application.deploy", parameter(request, "path", ""), "ERROR");
        throw exception;
      }
      if ("true".equals(request.getParameter("compileJsps"))) {
        for (Map<String, Object> app : runtime.tomcat.applications())
          if (parameter(request, "host", "localhost").equals(app.get("host"))
              && parameter(request, "path", "").equals(app.get("path"))
              && parameter(request, "version", "").equals(app.get("version")))
            result.put(
                "jspCompilation",
                runtime.tomcat.compileJsps(
                    String.valueOf(app.get("id")), Collections.emptyList(), request, response));
      }
      send(response, result);
      return;
    }
    Map<String, Object> input = body(request);
    if ("/alerts".equals(path)) {
      require(admin(request));
      runtime.alerts.configure(input);
      runtime.audit.event(user, "alerts.configure", "thresholds", "OK");
      send(response, runtime.alerts.snapshot());
      return;
    }
    if (parts.length == 3 && "applications".equals(parts[0]) && "monitoring".equals(parts[2])) {
      require(admin(request));
      String app = parts[1];
      runtime.tomcat.context(app);
      if ("stop".equals(Json.text(input, "action", ""))) runtime.profiles.stop(app);
      else {
        Object duration = input.get("seconds");
        if (duration != null
            && (!(duration instanceof Number)
                || ((Number) duration).doubleValue() != ((Number) duration).intValue()))
          throw new IllegalArgumentException("Diagnosedauer muss eine ganze Zahl sein.");
        runtime.profiles.change(
            app,
            Json.text(input, "mode", ""),
            duration == null ? 300 : ((Number) duration).intValue());
      }
      runtime.applications.changed(app);
      runtime.instrumentation.changed(app);
      runtime.audit.event(user, "monitoring." + runtime.profiles.mode(app).name(), app, "OK");
      send(response, applicationMonitoring(app));
      return;
    }
    if ("/deployments".equals(path)) {
      require(admin(request));
      runtime.tomcat.deployDescriptor(
          Json.text(input, "host", ""), Json.text(input, "filename", ""));
      runtime.audit.event(
          user, "application.deploy-descriptor", Json.text(input, "filename", ""), "OK");
      send(response, Json.map("ok", true));
      return;
    }
    if ("/logout".equals(path)) {
      String owner = owner(request);
      runtime.closeOwner(owner);
      request.logout();
      request.getSession().invalidate();
      send(response, Json.map("ok", true));
      return;
    }
    if ("/preferences".equals(path)) {
      require(sql(request));
      runtime.users.save(user, input);
      send(response, Json.map("ok", true));
      return;
    }
    if ("/sql".equals(path)) {
      require(sql(request));
      send(
          response,
          runtime.sql.open(
              owner(request),
              user,
              Json.text(input, "source", ""),
              !admin(request) && !request.isUserInRole("jerry-sql")));
      return;
    }
    if ("/logs/search".equals(path)) {
      send(response, Json.map("id", runtime.logs.startSearch(owner(request), user, input)));
      return;
    }
    if ("/gc".equals(path)) {
      require(admin(request));
      System.gc();
      runtime.audit.event(user, "jvm.gc", "JVM", "REQUESTED");
      send(response, Json.map("ok", true));
      return;
    }
    if ("/quickcheck".equals(path)) {
      require(admin(request));
      send(response, quickCheck());
      return;
    }
    if ("/wrapper/restart".equals(path)) {
      require(admin(request));
      require("RESTART".equals(Json.text(input, "confirmation", "")));
      runtime.audit.event(user, "jvm.restart", "JVM", "REQUESTED");
      runtime.tomcat.restartJvm();
      send(response, Json.map("ok", true));
      return;
    }
    if ("/loggers".equals(path)) {
      require(admin(request));
      runtime.tomcat.loggerLevel(
          Json.text(input, "app", "system"),
          Json.text(input, "framework", "JUL"),
          Json.text(input, "name", ""),
          Json.text(input, "level", "INFO"));
      runtime.audit.event(
          user, "logger.level", Json.text(input, "name", ""), Json.text(input, "level", ""));
      send(response, Json.map("ok", true));
      return;
    }
    if (parts.length >= 2 && "sql".equals(parts[0])) {
      require(sql(request));
      String id = parts[1];
      if ("DELETE".equals(request.getMethod()) && parts.length == 2) {
        runtime.sql.close(owner(request), id);
        send(response, Json.map("ok", true));
        return;
      }
      if (parts.length >= 3) {
        if ("execute".equals(parts[2]))
          send(response, runtime.sql.execute(owner(request), id, input));
        else if ("cancel".equals(parts[2])) {
          runtime.sql.cancel(owner(request), id);
          send(response, Json.map("ok", true));
        } else send(response, runtime.sql.control(owner(request), id, parts[2], input));
        return;
      }
    }
    if (parts.length >= 2 && "applications".equals(parts[0])) {
      require(operator(request));
      String app = parts[1];
      String action = Json.text(input, "action", "");
      if (parts.length >= 3 && "sessions".equals(parts[2])) {
        String attribute =
            "remove-attribute".equals(action) ? Json.text(input, "attribute", "") : null;
        Object ids = input.get("ids");
        if (!(ids instanceof List)) throw new IllegalArgumentException("Session-IDs fehlen.");
        if (((List<?>) ids).size() > 5000)
          throw new IllegalArgumentException("Zu viele Session-IDs.");
        for (Object id : (List<?>) ids)
          runtime.tomcat.sessionAction(app, String.valueOf(id), attribute);
      } else if (parts.length >= 3 && "attributes".equals(parts[2])) {
        require(admin(request));
        runtime.tomcat.removeContextAttribute(app, Json.text(input, "name", ""));
      } else if (parts.length >= 3 && "jsps".equals(parts[2])) {
        if ("discard".equals(action)) {
          require(admin(request));
          runtime.tomcat.applicationAction(app, "discard-jsps");
        } else {
          List<String> paths = new ArrayList<>();
          Object selected = input.get("paths");
          if (selected instanceof List)
            for (Object value : (List<?>) selected) paths.add(String.valueOf(value));
          send(response, runtime.tomcat.compileJsps(app, paths, request, response));
          runtime.audit.event(user, "jsp.compile", app, "COMPLETED");
          return;
        }
      } else {
        if ("undeploy".equals(action)) {
          require(admin(request));
          if (!app.equals(Json.text(input, "confirmation", "")))
            throw new IllegalArgumentException("Undeployment muss bestätigt werden.");
        }
        runtime.tomcat.applicationAction(app, action);
      }
      runtime.audit.event(user, "application." + action, app, "OK");
      send(response, Json.map("ok", true));
      return;
    }
    if (parts.length >= 2 && "datasources".equals(parts[0])) {
      require(sql(request));
      String action = Json.text(input, "action", "test");
      if ("reset".equals(action)) {
        require(admin(request));
        runtime.tomcat.resetPool(parts[1]);
      } else if ("test".equals(action)) {
        try (Connection connection = runtime.tomcat.resolve(parts[1]).getConnection()) {
          boolean valid = connection.isValid(5);
          if (!valid) throw new IllegalStateException("Datenbankverbindung ist nicht gültig.");
        }
      } else throw new IllegalArgumentException("Unbekannte Datenquellenaktion.");
      runtime.audit.event(user, "datasource." + action, parts[1], "OK");
      send(response, Json.map("ok", true));
      return;
    }
    if (parts.length == 3 && "logs".equals(parts[0]) && "search".equals(parts[1])) {
      if ("DELETE".equals(request.getMethod())) runtime.logs.removeSearch(owner(request), parts[2]);
      else runtime.logs.cancelSearch(owner(request), parts[2]);
      send(response, Json.map("ok", true));
      return;
    }
    if (parts.length == 2 && "threads".equals(parts[0])) {
      require(admin(request));
      boolean force = "stop".equals(Json.text(input, "action", "interrupt"));
      if (force) require(runtime.config.bool("threads.forceStop.enabled", false));
      runtime.monitoring.threadAction(Long.parseLong(parts[1]), force);
      runtime.audit.event(user, "thread." + (force ? "stop" : "interrupt"), parts[1], "REQUESTED");
      send(response, Json.map("ok", true));
      return;
    }
    error(response, 404, "API-Endpunkt nicht gefunden.");
  }

  private Map<String, Object> applicationMonitoring(String app) {
    return Json.map(
        "profile",
        runtime.profiles.state(app),
        "telemetry",
        runtime.telemetry.snapshot(app),
        "collection",
        runtime.applications.snapshot(app),
        "instrumentation",
        runtime.instrumentation.state(app));
  }

  private Map<String, Object> quickCheck() throws Exception {
    List<Map<String, Object>> checks = new ArrayList<>();
    checks.add(Json.map("name", "Tomcat-Adapter", "state", "OK", "detail", runtime.tomcat.info()));
    checks.add(
        Json.map(
            "name",
            "Datenverzeichnis beschreibbar",
            "state",
            java.nio.file.Files.isWritable(runtime.config.dataDirectory) ? "OK" : "ERROR",
            "detail",
            runtime.config.dataDirectory.toString()));
    boolean java8 = System.getProperty("java.specification.version").equals("1.8");
    checks.add(
        Json.map(
            "name",
            "Java-8-Zielplattform",
            "state",
            java8 ? "OK" : "INFO",
            "detail",
            System.getProperty("java.version")));
    for (Map<String, Object> app : runtime.tomcat.applications())
      if (!Boolean.TRUE.equals(app.get("running")))
        checks.add(
            Json.map(
                "name",
                "Anwendung " + app.get("name"),
                "state",
                "WARN",
                "detail",
                app.get("state")));
    List<Map<String, Object>> threads = runtime.monitoring.threads(false);
    long deadlocks =
        threads.stream().filter(thread -> Boolean.TRUE.equals(thread.get("deadlocked"))).count();
    checks.add(
        Json.map(
            "name", "Deadlocks", "state", deadlocks == 0 ? "OK" : "ERROR", "detail", deadlocks));
    checks.add(
        Json.map(
            "name",
            "Monitoring-Persistenz",
            "state",
            runtime.collectionError == null ? "OK" : "ERROR",
            "detail",
            runtime.collectionError));
    checks.add(
        Json.map("name", "SQL-Ressourcen", "state", "INFO", "detail", runtime.sql.diagnostics()));
    return Json.map("time", System.currentTimeMillis(), "checks", checks);
  }

  private static String parameter(HttpServletRequest request, String name, String fallback) {
    String value = request.getParameter(name);
    return value == null ? fallback : value;
  }

  private static long number(
      HttpServletRequest request, String name, long fallback, long min, long max) {
    String value = request.getParameter(name);
    if (value == null || value.isEmpty()) return fallback;
    try {
      return Math.max(min, Math.min(max, Long.parseLong(value)));
    } catch (NumberFormatException exception) {
      throw new IllegalArgumentException("Ungültiger Parameter: " + name);
    }
  }

  private static Map<String, Object> body(HttpServletRequest request) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = request.getInputStream().read(buffer)) != -1) {
      if (output.size() + read > 2 * 1024 * 1024)
        throw new IllegalArgumentException("Anfrage überschreitet 2 MB.");
      output.write(buffer, 0, read);
    }
    return output.size() == 0
        ? Json.map()
        : Json.MAPPER.readValue(output.toByteArray(), new TypeReference<Map<String, Object>>() {});
  }

  private static void send(HttpServletResponse response, Object value) throws IOException {
    Json.MAPPER.writeValue(response.getOutputStream(), value);
  }

  private static void error(HttpServletResponse response, int status, String message)
      throws IOException {
    response.resetBuffer();
    response.setHeader("Content-Disposition", null);
    response.setStatus(status);
    response.setContentType("application/json;charset=UTF-8");
    send(response, Json.map("error", message));
  }

  @Override
  public void destroy() {
    if (runtime != null) runtime.close();
    getServletContext().removeAttribute(JerryRuntime.KEY);
    wrapper = null;
    super.destroy();
  }
}
