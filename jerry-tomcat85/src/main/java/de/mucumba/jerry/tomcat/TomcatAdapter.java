package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.ApplicationTelemetry;
import de.mucumba.jerry.core.Config;
import de.mucumba.jerry.core.DataSources;
import de.mucumba.jerry.core.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Method;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.management.MBeanServer;
import javax.management.ObjectName;
import javax.naming.InitialContext;
import javax.servlet.RequestDispatcher;
import javax.servlet.ServletContext;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletRequestWrapper;
import javax.servlet.http.HttpServletResponse;
import javax.sql.DataSource;
import org.apache.catalina.Container;
import org.apache.catalina.Context;
import org.apache.catalina.Engine;
import org.apache.catalina.Host;
import org.apache.catalina.Session;
import org.apache.catalina.Wrapper;
import org.apache.catalina.connector.Connector;
import org.apache.catalina.util.ContextName;
import org.apache.catalina.util.ServerInfo;
import org.apache.tomcat.util.descriptor.web.ContextResource;
import org.apache.tomcat.util.descriptor.web.ContextResourceLink;
import org.apache.tomcat.util.descriptor.web.FilterDef;
import org.apache.tomcat.util.descriptor.web.FilterMap;

/** The only module that imports Catalina. No application services depend on Tomcat internals. */
public final class TomcatAdapter implements DataSources, AutoCloseable {
  private final Context self;
  private final Engine engine;
  private final Config config;
  private final Map<Host, RequestMetricsValve> valves = new LinkedHashMap<>();
  private final Map<String, Source> configured = new LinkedHashMap<>();
  private final Map<String, java.lang.ref.WeakReference<DataSource>> observedPools =
      new LinkedHashMap<>();
  private final Map<DataSource, String> poolIdentities = new java.util.WeakHashMap<>();
  private final MBeanServer mbeans = ManagementFactory.getPlatformMBeanServer();
  private final Map<String, long[]> clusterPrevious = new HashMap<>();

  private static final class Source {
    String app, name, configuredName;
    boolean readOnly;
  }

  public TomcatAdapter(Wrapper wrapper, Config config, ApplicationTelemetry telemetry) {
    if (wrapper == null)
      throw new IllegalStateException(
          "Jerry benötigt privileged=\"true\" in der Tomcat-Context-Konfiguration.");
    this.self = (Context) wrapper.getParent();
    this.engine = (Engine) self.getParent().getParent();
    this.config = config;
    for (Container child : engine.findChildren())
      if (child instanceof Host) {
        Host host = (Host) child;
        RequestMetricsValve valve = new RequestMetricsValve(telemetry);
        host.getPipeline().addValve(valve);
        valves.put(host, valve);
      }
    for (String key : config.properties().stringPropertyNames())
      if (key.startsWith("datasource.") && key.endsWith(".url")) {
        String name = key.substring(11, key.length() - 4);
        if (!name.matches("[A-Za-z0-9_-]{1,60}")) continue;
        Source source = new Source();
        source.configuredName = name;
        source.name = name;
        source.readOnly = config.bool("datasource." + name + ".readOnlyEnforced", false);
        configured.put("configured:" + name, source);
      }
  }

  List<Context> contexts() {
    List<Context> contexts = new ArrayList<>();
    for (Host host : valves.keySet())
      for (Container child : host.findChildren())
        if (child instanceof Context) contexts.add((Context) child);
    return contexts;
  }

  public static String id(Context context) {
    return encode(context.getParent().getName() + "|" + context.getName());
  }

  private static String encode(String input) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(input.getBytes(StandardCharsets.UTF_8));
  }

  public Context context(String id) {
    for (Context context : contexts()) if (id(context).equals(id)) return context;
    throw new IllegalArgumentException("Anwendung existiert nicht mehr.");
  }

  public Map<String, Object> info() {
    return Json.map(
        "server",
        ServerInfo.getServerInfo(),
        "java",
        System.getProperty("java.version"),
        "host",
        self.getParent().getName(),
        "engine",
        engine.getName(),
        "context",
        self.getPath(),
        "capabilities",
        Json.map("privileged", true, "requestHistograms", true, "wrapper", wrapperAvailable()));
  }

  public List<Map<String, Object>> applications() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Context context : contexts()) {
      org.apache.catalina.Manager manager = context.getManager();
      long requests = 0, errors = 0, processing = 0;
      for (Container child : context.findChildren())
        if (child instanceof Wrapper) {
          Wrapper servlet = (Wrapper) child;
          requests += statistic(servlet, "getRequestCount");
          errors += statistic(servlet, "getErrorCount");
          processing += statistic(servlet, "getProcessingTime");
        }
      result.add(
          Json.map(
              "id",
              id(context),
              "host",
              context.getParent().getName(),
              "name",
              context.getName(),
              "path",
              context.getPath(),
              "version",
              context.getWebappVersion(),
              "displayName",
              context.getDisplayName(),
              "state",
              context.getStateName(),
              "running",
              context.getState().isAvailable(),
              "self",
              context == self,
              "sessions",
              manager == null ? null : manager.getActiveSessions(),
              "requests",
              requests,
              "errors",
              errors,
              "processingTime",
              processing,
              "docBase",
              context.getDocBase()));
    }
    result.sort(
        (a, b) ->
            (a.get("host") + ":" + a.get("name")).compareTo(b.get("host") + ":" + b.get("name")));
    return result;
  }

  public Map<String, Object> details(String app, boolean attributeValues) throws Exception {
    Context context = context(app);
    ServletContext sc = context.getServletContext();
    List<Map<String, Object>> servlets = new ArrayList<>(),
        filters = new ArrayList<>(),
        attributes = attributes(sc, attributeValues),
        parameters = new ArrayList<>();
    for (Container child : context.findChildren())
      if (child instanceof Wrapper) {
        Wrapper servlet = (Wrapper) child;
        List<Map<String, Object>> init = new ArrayList<>();
        for (String name : servlet.findInitParameters())
          init.add(Json.map("name", name, "value", redact(name, servlet.findInitParameter(name))));
        servlets.add(
            Json.map(
                "name",
                servlet.getName(),
                "className",
                servlet.getServletClass(),
                "mappings",
                Arrays.asList(servlet.findMappings()),
                "loadOnStartup",
                servlet.getLoadOnStartup(),
                "requests",
                statistic(servlet, "getRequestCount"),
                "errors",
                statistic(servlet, "getErrorCount"),
                "processingTime",
                statistic(servlet, "getProcessingTime"),
                "initParameters",
                init));
      }
    for (FilterDef filter : context.findFilterDefs()) {
      List<Map<String, Object>> mappings = new ArrayList<>();
      for (FilterMap map : context.findFilterMaps())
        if (filter.getFilterName().equals(map.getFilterName()))
          mappings.add(
              Json.map(
                  "urls",
                  Arrays.asList(map.getURLPatterns()),
                  "servlets",
                  Arrays.asList(map.getServletNames()),
                  "dispatchers",
                  Arrays.asList(map.getDispatcherNames())));
      filters.add(
          Json.map(
              "name",
              filter.getFilterName(),
              "className",
              filter.getFilterClass(),
              "mappings",
              mappings));
    }
    for (String name : Collections.list(sc.getInitParameterNames()))
      parameters.add(Json.map("name", name, "value", redact(name, sc.getInitParameter(name))));
    return Json.map(
        "id",
        app,
        "servlets",
        servlets,
        "filters",
        filters,
        "attributes",
        attributes,
        "parameters",
        parameters,
        "webXml",
        resource(context, "/WEB-INF/web.xml"),
        "contextXml",
        contextXml(context));
  }

  private String contextXml(Context context) throws IOException {
    URL location = context.getConfigFile();
    if (location == null) return null;
    try (InputStream input = location.openStream()) {
      return readLimited(input, 1024 * 1024);
    }
  }

  public String resource(Context context, String path) throws IOException {
    try (InputStream input =
        context.getServletContext().getResourceAsStream(localResourcePath(path))) {
      return input == null ? null : readLimited(input, 2 * 1024 * 1024);
    }
  }

  /** Accept only absolute, normalized web application resource paths. */
  static String localResourcePath(String path) {
    if (path == null || !path.startsWith("/") || path.indexOf('\\') >= 0) {
      throw new IllegalArgumentException("Ungültiger Anwendungspfad.");
    }
    for (String segment : path.substring(1).split("/", -1)) {
      if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment))
        throw new IllegalArgumentException("Ungültiger Anwendungspfad.");
      for (int i = 0; i < segment.length(); i++) {
        if (Character.isISOControl(segment.charAt(i)))
          throw new IllegalArgumentException("Ungültiger Anwendungspfad.");
      }
    }
    return path;
  }

  private static String readLimited(InputStream input, int limit) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[8192];
    int read;
    while ((read = input.read(buffer)) != -1) {
      if (out.size() + read > limit) throw new IOException("Datei überschreitet das Anzeigelimit.");
      out.write(buffer, 0, read);
    }
    return new String(out.toByteArray(), StandardCharsets.UTF_8);
  }

  private static List<Map<String, Object>> attributes(ServletContext context, boolean values) {
    List<Map<String, Object>> result = new ArrayList<>();
    for (String name : Collections.list(context.getAttributeNames())) {
      Object value = context.getAttribute(name);
      result.add(
          Json.map(
              "name",
              name,
              "type",
              value == null ? null : value.getClass().getName(),
              "value",
              values ? safeValue(value) : null));
    }
    return result;
  }

  public void removeContextAttribute(String app, String name) {
    if (name.startsWith("org.apache.") || name.startsWith("javax."))
      throw new IllegalArgumentException("Container-Attribute können nicht entfernt werden.");
    context(app).getServletContext().removeAttribute(name);
  }

  public static Object safeValue(Object value) {
    Object result =
        safeValue(value, 0, new java.util.IdentityHashMap<Object, Boolean>(), new int[] {0});
    if (result instanceof Map || result instanceof List)
      try {
        String text = Json.MAPPER.writeValueAsString(result);
        return text.length() > 8192 ? text.substring(0, 8192) + "…" : text;
      } catch (IOException exception) {
        return "<Darstellung nicht verfügbar>";
      }
    return result;
  }

  private static Object safeValue(
      Object value, int depth, java.util.IdentityHashMap<Object, Boolean> visited, int[] count) {
    if (++count[0] > 150) return "<Darstellung begrenzt>";
    if (value == null) return null;
    if (value instanceof String
        || value instanceof Number
        || value instanceof Boolean
        || value instanceof Character
        || value.getClass().isEnum()) {
      String text = String.valueOf(value);
      int maximum = depth == 0 ? 8192 : 1024;
      return text.length() > maximum ? text.substring(0, maximum) + "…" : text;
    }
    if (value instanceof byte[]) return "byte[" + ((byte[]) value).length + "]";
    if (depth < 3 && count[0] < 150 && visited.put(value, Boolean.TRUE) == null) {
      if (value instanceof Map) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet()) {
          String key =
              entry.getKey() instanceof String
                  ? (String) entry.getKey()
                  : "<"
                      + (entry.getKey() == null ? "null" : entry.getKey().getClass().getName())
                      + ">";
          result.put(key, redact(key, safeValue(entry.getValue(), depth + 1, visited, count)));
          if (result.size() >= 50) break;
        }
        return result;
      }
      if (value instanceof java.util.Collection) {
        List<Object> result = new ArrayList<>();
        for (Object item : (java.util.Collection<?>) value) {
          result.add(safeValue(item, depth + 1, visited, count));
          if (result.size() >= 50) break;
        }
        return result;
      }
      if (value.getClass().isArray()) {
        List<Object> result = new ArrayList<>();
        for (int i = 0; i < Math.min(50, java.lang.reflect.Array.getLength(value)); i++)
          result.add(safeValue(java.lang.reflect.Array.get(value, i), depth + 1, visited, count));
        return result;
      }
    }
    return "<" + value.getClass().getName() + ">";
  }

  private static Object redact(String key, Object value) {
    return key.toLowerCase(Locale.ROOT).matches(".*(password|passwd|secret|token|credential).*")
        ? "••••••"
        : value;
  }

  public List<Map<String, Object>> sessions(String app, String query, boolean estimate) {
    return sessions(app, query, estimate, null);
  }

  public List<Map<String, Object>> sessions(
      String app, String query, boolean estimate, String selectedSession) {
    Context context = context(app);
    List<Map<String, Object>> result = new ArrayList<>();
    if (context.getManager() == null) return result;
    for (Session session : context.getManager().findSessions()) {
      if (selectedSession != null && !selectedSession.equals(session.getId())) continue;
      if (!session.isValid()) continue;
      javax.servlet.http.HttpSession http = session.getSession();
      List<Map<String, Object>> attributes = new ArrayList<>();
      long estimated = 0;
      boolean searchable = query == null || query.isEmpty() || session.getId().contains(query);
      try {
        long displayedBytes = 0;
        boolean truncated = false;
        if (selectedSession != null || estimate || (query != null && !query.isEmpty()))
          for (String name : Collections.list(http.getAttributeNames())) {
            Object value = http.getAttribute(name);
            Object display = selectedSession != null || !searchable ? safeValue(value) : null;
            if (query != null
                && (name.contains(query)
                    || (value instanceof String && ((String) value).contains(query))
                    || String.valueOf(display).contains(query))) searchable = true;
            long size = estimate ? estimateSize(value) : -1;
            if (size > 0) estimated += size;
            if (selectedSession != null) {
              displayedBytes += String.valueOf(display).length() * 2L;
              if (attributes.size() < 500 && displayedBytes < 1024 * 1024)
                attributes.add(
                    Json.map(
                        "name",
                        name,
                        "type",
                        value == null ? null : value.getClass().getName(),
                        "value",
                        redact(name, display),
                        "estimatedBytes",
                        size < 0 ? null : size));
              else truncated = true;
            }
          }
        if (searchable)
          result.add(
              Json.map(
                  "id",
                  session.getId(),
                  "created",
                  http.getCreationTime(),
                  "lastAccessed",
                  http.getLastAccessedTime(),
                  "maxInactiveSeconds",
                  http.getMaxInactiveInterval(),
                  "lastIp",
                  session.getNote("de.mucumba.jerry.lastIp"),
                  "attributes",
                  attributes,
                  "attributesTruncated",
                  truncated,
                  "estimatedBytes",
                  estimate ? estimated : null));
      } catch (IllegalStateException ignored) {
      }
      if (result.size() >= 5000) break;
    }
    return result;
  }

  private static long estimateSize(Object value) {
    if (value == null) return 0;
    if (value instanceof String) return 40L + ((String) value).length() * 2L;
    if (value instanceof byte[]) return 24L + ((byte[]) value).length;
    if (value instanceof Number || value instanceof Boolean || value instanceof Character)
      return 24;
    return -1;
  }

  public void sessionAction(String app, String sessionId, String attribute) throws IOException {
    Context context = context(app);
    Session session = context.getManager().findSession(sessionId);
    if (session == null || !session.isValid())
      throw new IllegalArgumentException("Session existiert nicht mehr.");
    if (attribute == null) session.expire();
    else session.getSession().removeAttribute(attribute);
  }

  public synchronized void applicationAction(String app, String action) throws Exception {
    Context context = context(app);
    if (context == self)
      throw new IllegalArgumentException("Jerry kann sich nicht selbst verändern.");
    switch (action) {
      case "start":
        context.start();
        break;
      case "stop":
        context.stop();
        break;
      case "reload":
        context.reload();
        break;
      case "undeploy":
        undeploy(context);
        break;
      case "discard-jsps":
        discardJsps(context);
        break;
      default:
        throw new IllegalArgumentException("Unbekannte Anwendungsaktion.");
    }
  }

  private void undeploy(Context context) throws Exception {
    ObjectName name =
        new ObjectName(
            engine.getName()
                + ":type=Deployer,host="
                + ObjectName.quote(context.getParent().getName()));
    if (!mbeans.isRegistered(name))
      name =
          new ObjectName(engine.getName() + ":type=Deployer,host=" + context.getParent().getName());
    if (!mbeans.isRegistered(name))
      throw new IllegalStateException("Tomcat HostConfig-Deployer ist nicht verfügbar.");
    Host host = (Host) context.getParent();
    ContextName contextName = new ContextName(context.getName(), false);
    Path appBase = appBase(host), war = appBase.resolve(contextName.getBaseName() + ".war");
    Path unpacked = appBase.resolve(contextName.getBaseName());
    Path configBase = configBase(host),
        descriptor = configBase.resolve(contextName.getBaseName() + ".xml");
    if (Files.exists(war)) Files.delete(war);
    if (Files.exists(descriptor)) Files.delete(descriptor);
    if (Files.exists(unpacked)
        && unpacked.toRealPath().startsWith(appBase.toRealPath())
        && !Files.isSymbolicLink(unpacked)) deleteTree(unpacked, appBase);
    mbeans.invoke(
        name, "check", new Object[] {context.getName()}, new String[] {"java.lang.String"});
    if (host.findChild(context.getName()) != null) {
      context.stop();
      context.destroy();
      host.removeChild(context);
    }
  }

  private Path appBase(Host host) {
    Path path = Paths.get(host.getAppBase());
    return (path.isAbsolute() ? path : Paths.get(System.getProperty("catalina.base")).resolve(path))
        .toAbsolutePath()
        .normalize();
  }

  private Path configBase(Host host) {
    return Paths.get(System.getProperty("catalina.base"), "conf", engine.getName(), host.getName())
        .toAbsolutePath()
        .normalize();
  }

  public synchronized Map<String, Object> deploy(
      String hostName, String path, String version, InputStream input) throws Exception {
    Host host = null;
    for (Host candidate : valves.keySet())
      if (candidate.getName().equals(hostName)) host = candidate;
    if (host == null) throw new IllegalArgumentException("Unbekannter Host.");
    if (!path.matches("(?:/[A-Za-z0-9_-]+)*")
        || path.length() > 160
        || !version.matches("[A-Za-z0-9._-]{0,40}"))
      throw new IllegalArgumentException("Ungültiger Context-Pfad oder Version.");
    ContextName contextName = new ContextName(path, version);
    if (host.findChild(contextName.getName()) != null)
      throw new IllegalStateException(
          "Anwendung existiert bereits. Zum Ersetzen zuerst explizit undeployen.");
    Path base = appBase(host);
    Files.createDirectories(base);
    Path war = base.resolve(contextName.getBaseName() + ".war");
    if (!war.normalize().startsWith(base) || Files.exists(war))
      throw new IllegalArgumentException("Deployment-Ziel existiert bereits oder ist ungültig.");
    Path staging = config.dataDirectory.resolve("deploy");
    Files.createDirectories(staging);
    Path temporary = staging.resolve(UUID.randomUUID().toString() + ".war");
    try {
      long maximum = config.number("deployment.war.mb", 256, 1, 2048) * 1024L * 1024, count = 0;
      try (java.io.OutputStream out = Files.newOutputStream(temporary)) {
        byte[] bytes = new byte[65536];
        int read;
        while ((read = input.read(bytes)) != -1) {
          count += read;
          if (count > maximum) throw new IOException("WAR überschreitet das Uploadlimit.");
          out.write(bytes, 0, read);
        }
      }
      int entries = 0;
      long expanded = 0;
      try (ZipInputStream zip = new ZipInputStream(Files.newInputStream(temporary))) {
        ZipEntry entry;
        byte[] bytes = new byte[65536];
        while ((entry = zip.getNextEntry()) != null) {
          entries++;
          String name = entry.getName().replace('\\', '/');
          if (name.startsWith("/")
              || name.contains(":")
              || Arrays.asList(name.split("/")).contains(".."))
            throw new IOException("Unsicherer Pfad in der WAR-Datei.");
          int read;
          while ((read = zip.read(bytes)) != -1) {
            expanded += read;
            if (expanded > maximum * 10L || entries > 100000)
              throw new IOException("Entpacklimit der WAR überschritten.");
          }
        }
      }
      if (entries == 0) throw new IOException("Keine gültige WAR-/ZIP-Datei.");
      try {
        Files.move(temporary, war, StandardCopyOption.ATOMIC_MOVE);
      } catch (java.nio.file.AtomicMoveNotSupportedException exception) {
        Files.copy(temporary, war);
        Files.delete(temporary);
      }
      ObjectName deployer =
          new ObjectName(engine.getName() + ":type=Deployer,host=" + host.getName());
      if (mbeans.isRegistered(deployer))
        mbeans.invoke(
            deployer,
            "check",
            new Object[] {contextName.getName()},
            new String[] {"java.lang.String"});
      else
        throw new IllegalStateException(
            "WAR wurde abgelegt, aber der HostConfig-Deployer ist nicht verfügbar.");
      return Json.map(
          "host", hostName, "path", path, "version", version, "bytes", count, "state", "DEPLOYED");
    } finally {
      Files.deleteIfExists(temporary);
    }
  }

  public List<Map<String, Object>> hosts() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Host host : valves.keySet())
      result.add(
          Json.map(
              "name",
              host.getName(),
              "autoDeploy",
              host.getAutoDeploy(),
              "appBase",
              appBase(host).toString()));
    return result;
  }

  public List<Map<String, Object>> deploymentDescriptors() throws IOException {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Host host : valves.keySet()) {
      Path base = configBase(host);
      if (!Files.isDirectory(base)) continue;
      try (java.nio.file.DirectoryStream<Path> files = Files.newDirectoryStream(base, "*.xml")) {
        for (Path file : files) {
          if (Files.isSymbolicLink(file) || !Files.isRegularFile(file)) continue;
          ContextName name = new ContextName(file.getFileName().toString(), true);
          result.add(
              Json.map(
                  "host",
                  host.getName(),
                  "filename",
                  file.getFileName().toString(),
                  "path",
                  name.getPath(),
                  "version",
                  name.getVersion(),
                  "deployed",
                  host.findChild(name.getName()) != null));
        }
      }
    }
    return result;
  }

  public synchronized void deployDescriptor(String hostName, String filename) throws Exception {
    if (!filename.matches("[A-Za-z0-9_#.-]+\\.xml"))
      throw new IllegalArgumentException("Ungültiger Deskriptor-Dateiname.");
    for (Host host : valves.keySet())
      if (host.getName().equals(hostName)) {
        Path base = configBase(host), file = base.resolve(filename);
        if (!Files.isRegularFile(file)
            || Files.isSymbolicLink(file)
            || !file.toRealPath().startsWith(base.toRealPath()))
          throw new IllegalArgumentException("Context-Deskriptor existiert nicht.");
        ContextName context = new ContextName(filename, true);
        if (host.findChild(context.getName()) != null)
          throw new IllegalStateException("Context ist bereits bereitgestellt.");
        mbeans.invoke(
            new ObjectName(engine.getName() + ":type=Deployer,host=" + hostName),
            "check",
            new Object[] {context.getName()},
            new String[] {"java.lang.String"});
        return;
      }
    throw new IllegalArgumentException("Unbekannter Host.");
  }

  @Override
  public List<Map<String, Object>> list() throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Context context : contexts()) {
      for (ContextResource resource : context.getNamingResources().findResources())
        if (isDataSource(resource.getType()))
          result.add(
              sourceRow(
                  id(context),
                  resource.getName(),
                  context.getName(),
                  resource.getType(),
                  resource.getProperty("url")));
      for (ContextResourceLink resource : context.getNamingResources().findResourceLinks())
        if (isDataSource(resource.getType()))
          result.add(
              sourceRow(
                  id(context), resource.getName(), context.getName(), resource.getType(), null));
    }
    for (ContextResource resource :
        engine.getService().getServer().getGlobalNamingResources().findResources())
      if (isDataSource(resource.getType()))
        result.add(
            sourceRow(
                "global",
                resource.getName(),
                "Global",
                resource.getType(),
                resource.getProperty("url")));
    for (Map.Entry<String, Source> entry : configured.entrySet()) {
      Source source = entry.getValue();
      result.add(
          Json.map(
              "id",
              entry.getKey(),
              "name",
              source.name,
              "application",
              "Jerry-Konfiguration",
              "type",
              "JDBC",
              "url",
              maskUrl(config.get("datasource." + source.name + ".url", "")),
              "readOnlyEnforced",
              source.readOnly));
    }
    return result;
  }

  private static boolean isDataSource(String type) {
    return "javax.sql.DataSource".equals(type) || "javax.sql.XADataSource".equals(type);
  }

  private Map<String, Object> sourceRow(
      String app, String name, String application, String type, Object url) {
    return Json.map(
        "id",
        encode(app + "\n" + name),
        "name",
        name,
        "application",
        application,
        "type",
        type,
        "url",
        url == null ? null : maskUrl(String.valueOf(url)),
        "readOnlyEnforced",
        false);
  }

  private static String maskUrl(String input) {
    return input
        .replaceAll(
            "(?i)(password|passwd|pwd|user|username|token|accessToken|secret)=([^;&? ]*)", "$1=***")
        .replaceAll("//[^/@:]+:[^/@]+@", "//***@")
        .replaceAll("(?i)(jdbc:oracle:thin:)[^@]+@", "$1***@");
  }

  @Override
  public DataSource resolve(String id) throws Exception {
    Source configuredSource = configured.get(id);
    if (configuredSource != null) return new ConfiguredDataSource(config, configuredSource.name);
    // The request supplies only an identifier. Resolve the lookup name from the current
    // container configuration, never by decoding a caller-controlled name for JNDI.
    Object value = null;
    boolean registered = false;
    for (ContextResource resource :
        engine.getService().getServer().getGlobalNamingResources().findResources()) {
      if (isDataSource(resource.getType()) && id.equals(encode("global\n" + resource.getName()))) {
        value =
            engine
                .getService()
                .getServer()
                .getGlobalNamingContext()
                .lookup(localJndiName(resource.getName()));
        registered = true;
        break;
      }
    }
    if (!registered) {
      for (Context context : contexts()) {
        String application = id(context);
        for (ContextResource resource : context.getNamingResources().findResources()) {
          if (isDataSource(resource.getType())
              && id.equals(encode(application + "\n" + resource.getName()))) {
            value = lookupApplicationDataSource(context, resource.getName());
            registered = true;
            break;
          }
        }
        if (!registered) {
          for (ContextResourceLink link : context.getNamingResources().findResourceLinks()) {
            if (isDataSource(link.getType())
                && id.equals(encode(application + "\n" + link.getName()))) {
              value = lookupApplicationDataSource(context, link.getName());
              registered = true;
              break;
            }
          }
        }
        if (registered) break;
      }
    }
    if (!registered) throw new IllegalArgumentException("Datenquelle existiert nicht mehr.");
    if (!(value instanceof DataSource))
      throw new IllegalArgumentException(
          "Diese Ressource ist keine lokale JDBC-Datenquelle. XA-Transaktionen sind im SQL-Client nicht vorgesehen.");
    DataSource source = (DataSource) value;
    synchronized (observedPools) {
      observedPools.entrySet().removeIf(entry -> entry.getValue().get() == null);
      if (observedPools.size() < 64 || observedPools.containsKey(id)) {
        observedPools.put(id, new java.lang.ref.WeakReference<>(source));
        if (!poolIdentities.containsKey(source))
          poolIdentities.put(source, UUID.randomUUID().toString());
      }
    }
    return source;
  }

  private Object lookupApplicationDataSource(Context context, String name) throws Exception {
    String localName = localJndiName(name);
    ClassLoader previous = context.bind(false, null);
    try {
      return new InitialContext().lookup("java:comp/env/" + localName);
    } finally {
      context.unbind(false, previous);
    }
  }

  /** Reject URL-style and traversal names before resolving a registered local resource. */
  static String localJndiName(String name) {
    if (name == null || name.isEmpty() || name.indexOf(':') >= 0 || name.indexOf('\\') >= 0) {
      throw new IllegalArgumentException("Ungültiger lokaler JNDI-Name.");
    }
    for (String segment : name.split("/", -1)) {
      if (segment.isEmpty() || ".".equals(segment) || "..".equals(segment))
        throw new IllegalArgumentException("Ungültiger lokaler JNDI-Name.");
      for (int i = 0; i < segment.length(); i++) {
        if (Character.isISOControl(segment.charAt(i)))
          throw new IllegalArgumentException("Ungültiger lokaler JNDI-Name.");
      }
    }
    return name;
  }

  @Override
  public boolean enforcedReadOnly(String id) {
    Source source = configured.get(id);
    return source != null && source.readOnly;
  }

  public Map<String, Object> pool(String id) throws Exception {
    DataSource source = resolve(id);
    return poolValues(source);
  }

  private Map<String, Object> poolValues(DataSource source) {
    Object target = source;
    Object hikari = invokeOptional(source, "getHikariPoolMXBean");
    if (hikari != null) target = hikari;
    return Json.map(
        "className",
        source.getClass().getName(),
        "active",
        first(
            target,
            "getActiveConnections",
            "getNumActive",
            "getActive",
            "getNumBusyConnectionsDefaultUser"),
        "idle",
        first(
            target,
            "getIdleConnections",
            "getNumIdle",
            "getIdle",
            "getNumIdleConnectionsDefaultUser"),
        "max",
        first(source, "getMaximumPoolSize", "getMaxTotal", "getMaxActive", "getMaxPoolSize"),
        "waiting",
        first(
            target,
            "getThreadsAwaitingConnection",
            "getWaitCount",
            "getNumThreadsAwaitingCheckoutDefaultUser",
            "getPendingRequestsCount"));
  }

  /** Only reads sources already resolved by Jerry; never looks up JNDI or opens a connection. */
  public List<Map<String, Object>> observedPoolMetrics() {
    Map<String, DataSource> sources = new LinkedHashMap<>();
    synchronized (observedPools) {
      observedPools.entrySet().removeIf(entry -> entry.getValue().get() == null);
      for (Map.Entry<String, java.lang.ref.WeakReference<DataSource>> entry :
          observedPools.entrySet()) {
        DataSource source = entry.getValue().get();
        if (source != null) sources.put(entry.getKey(), source);
      }
    }
    java.util.IdentityHashMap<DataSource, Map<String, Object>> readOnce =
        new java.util.IdentityHashMap<>();
    List<Map<String, Object>> result = new ArrayList<>();
    for (Map.Entry<String, DataSource> entry : sources.entrySet()) {
      DataSource source = entry.getValue();
      Map<String, Object> values = readOnce.get(source);
      if (values == null) {
        values = poolValues(source);
        readOnce.put(source, values);
      }
      if (!(values.get("active") instanceof Number)
          && !(values.get("idle") instanceof Number)
          && !(values.get("max") instanceof Number)) continue;
      String poolId;
      synchronized (observedPools) {
        poolId = poolIdentities.get(source);
      }
      Map<String, Object> row = new LinkedHashMap<>(values);
      row.remove("className");
      row.put("id", entry.getKey());
      row.put("poolId", poolId);
      try {
        String decoded =
            new String(Base64.getUrlDecoder().decode(entry.getKey()), StandardCharsets.UTF_8);
        int split = decoded.indexOf('\n');
        if (split >= 0) row.put("name", decoded.substring(split + 1));
      } catch (IllegalArgumentException ignored) {
      }
      result.add(row);
    }
    return result;
  }

  public void resetPool(String id) throws Exception {
    Object target = resolve(id);
    Object hikari = invokeOptional(target, "getHikariPoolMXBean");
    if (hikari != null) target = hikari;
    for (String method :
        Arrays.asList("softEvictConnections", "purge", "restart", "softResetAllUsers")) {
      try {
        target.getClass().getMethod(method).invoke(target);
        return;
      } catch (NoSuchMethodException ignored) {
      }
    }
    throw new IllegalStateException("Dieser Pool stellt keine unterstützte Reset-Funktion bereit.");
  }

  private static Object invokeOptional(Object target, String method) {
    try {
      return target.getClass().getMethod(method).invoke(target);
    } catch (Exception ignored) {
      return null;
    }
  }

  private static long statistic(Object target, String method) {
    Object value = invokeOptional(target, method);
    return value instanceof Number ? ((Number) value).longValue() : 0;
  }

  private static Object first(Object target, String... methods) {
    for (String method : methods) {
      Object result = invokeOptional(target, method);
      if (result instanceof Number) return result;
    }
    return null;
  }

  public List<Map<String, Object>> requestMetrics() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (RequestMetricsValve valve : valves.values()) result.addAll(valve.snapshot());
    return result;
  }

  public synchronized List<Map<String, Object>> clusterMetrics() {
    List<Map<String, Object>> result = new ArrayList<>();
    long now = System.currentTimeMillis();
    for (Context context : contexts()) {
      Object manager = context.getManager();
      if (manager == null) continue;
      long sent = 0, received = 0;
      boolean available = false;
      for (Method method : manager.getClass().getMethods())
        if (method.getParameterTypes().length == 0
            && (method.getName().startsWith("getCounterSend_")
                || method.getName().startsWith("getCounterReceive_"))) {
          try {
            Object value = method.invoke(manager);
            if (value instanceof Number) {
              available = true;
              if (method.getName().startsWith("getCounterSend_"))
                sent += ((Number) value).longValue();
              else received += ((Number) value).longValue();
            }
          } catch (Exception ignored) {
          }
        }
      if (!available) continue;
      String id = id(context);
      long[] prior = clusterPrevious.put(id, new long[] {sent, received, now});
      double seconds = prior == null ? 0 : (now - prior[2]) / 1000.0;
      result.add(
          Json.map(
              "id",
              id,
              "application",
              context.getParent().getName() + "|" + context.getName(),
              "sent",
              sent,
              "received",
              received,
              "sentRate",
              prior != null && seconds > 0 && sent >= prior[0] ? (sent - prior[0]) / seconds : null,
              "receivedRate",
              prior != null && seconds > 0 && received >= prior[1]
                  ? (received - prior[1]) / seconds
                  : null));
    }
    return result;
  }

  public List<Map<String, Object>> connectors() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Connector connector : engine.getService().findConnectors())
      result.add(
          Json.map(
              "port",
              connector.getPort(),
              "localPort",
              connector.getLocalPort(),
              "protocol",
              connector.getProtocol(),
              "scheme",
              connector.getScheme(),
              "secure",
              connector.getSecure(),
              "state",
              connector.getStateName(),
              "executor",
              String.valueOf(connector.getProtocolHandler().getExecutor())));
    return result;
  }

  /** Counts each connector's worker executor once, even when connectors share a pool. */
  public Integer connectorBusyWorkers() {
    List<java.util.concurrent.Executor> workers = new ArrayList<>();
    try {
      // StandardServer holds its services lock while starting applications on other threads.
      // Synchronous reads from servlet init would otherwise deadlock server startup.
      if (engine.getService().getServer().getState() != org.apache.catalina.LifecycleState.STARTED)
        return null;
      for (org.apache.catalina.Service service : engine.getService().getServer().findServices())
        for (Connector connector : service.findConnectors())
          if (connector.getState().isAvailable())
            workers.add(connector.getProtocolHandler().getExecutor());
      return countActiveWorkers(workers);
    } catch (RuntimeException exception) {
      return null;
    }
  }

  static Integer countActiveWorkers(Iterable<java.util.concurrent.Executor> workers) {
    java.util.IdentityHashMap<java.util.concurrent.Executor, Boolean> seen =
        new java.util.IdentityHashMap<>();
    int active = 0;
    for (java.util.concurrent.Executor worker : workers) {
      if (worker == null) return null;
      if (seen.put(worker, Boolean.TRUE) != null) continue;
      int count;
      if (worker instanceof org.apache.catalina.core.StandardThreadExecutor)
        count = ((org.apache.catalina.core.StandardThreadExecutor) worker).getActiveCount();
      else if (worker instanceof java.util.concurrent.ThreadPoolExecutor)
        count = ((java.util.concurrent.ThreadPoolExecutor) worker).getActiveCount();
      else return null;
      if (count < 0) return null;
      active += count;
    }
    return seen.isEmpty() ? null : active;
  }

  public Map<String, Object> cluster() {
    List<Map<String, Object>> result = new ArrayList<>();
    for (Host host : valves.keySet()) {
      org.apache.catalina.Cluster cluster = host.getCluster();
      if (cluster == null) cluster = engine.getCluster();
      Map<String, Object> item =
          Json.map(
              "host",
              host.getName(),
              "enabled",
              cluster != null,
              "className",
              cluster == null ? null : cluster.getClass().getName());
      if (cluster != null) {
        Object members = invokeOptional(cluster, "getMembers");
        List<String> names = new ArrayList<>();
        if (members instanceof Object[])
          for (Object member : (Object[]) members) names.add(String.valueOf(member));
        item.put("members", names);
        item.put("localMember", String.valueOf(invokeOptional(cluster, "getLocalMember")));
      }
      result.add(item);
    }
    return Json.map("hosts", result);
  }

  public List<String> jsps(String app) {
    List<String> paths = new ArrayList<>();
    collectJsps(context(app).getServletContext(), "/", paths, 0);
    return paths;
  }

  private void collectJsps(ServletContext sc, String path, List<String> result, int depth) {
    if (depth > 30 || result.size() > 20000) return;
    Set<String> paths = sc.getResourcePaths(path);
    if (paths == null) return;
    for (String child : new TreeSet<>(paths))
      if (child.endsWith("/") && !child.startsWith("/WEB-INF/lib/"))
        collectJsps(sc, child, result, depth + 1);
      else if (child.endsWith(".jsp") || child.endsWith(".jspx")) result.add(child);
  }

  public Map<String, Object> jspSource(String app, String path) throws IOException {
    Context context = context(app);
    localResourcePath(path);
    String registeredPath = null;
    for (String candidate : jsps(app)) {
      if (candidate.equals(path)) {
        registeredPath = candidate;
        break;
      }
    }
    if (registeredPath == null) throw new IllegalArgumentException("JSP existiert nicht.");
    path = registeredPath;
    String javaPath =
        "org/apache/jsp"
            + path.substring(0, path.lastIndexOf('/'))
            + "/"
            + org.apache.jasper.compiler.JspUtil.makeJavaIdentifier(
                path.substring(path.lastIndexOf('/') + 1))
            + ".java";
    Object temporary = context.getServletContext().getAttribute(ServletContext.TEMPDIR);
    String generated = null;
    if (temporary instanceof java.io.File) {
      Path work = ((java.io.File) temporary).toPath().toAbsolutePath().normalize(),
          source = work.resolve(javaPath).normalize();
      if (source.startsWith(work) && Files.isRegularFile(source))
        try (InputStream in = Files.newInputStream(source)) {
          generated = readLimited(in, 2 * 1024 * 1024);
        }
    }
    return Json.map("path", path, "source", resource(context, path), "generated", generated);
  }

  public List<Map<String, Object>> compileJsps(
      String app, List<String> paths, HttpServletRequest request, HttpServletResponse response)
      throws Exception {
    Context context = context(app);
    List<String> available = jsps(app);
    if (paths.isEmpty()) paths = available;
    List<Map<String, Object>> results = new ArrayList<>();
    if (paths.size() > 2000) throw new IllegalArgumentException("Maximal 2000 JSPs pro Auftrag.");
    for (String path : paths) {
      if (!available.contains(path)) throw new IllegalArgumentException("Unbekannte JSP.");
      long start = System.nanoTime();
      try {
        RequestDispatcher dispatcher =
            context.getServletContext().getRequestDispatcher(path + "?jsp_precompile=true");
        HttpServletRequestWrapper wrapped =
            new HttpServletRequestWrapper(request) {
              @Override
              public String getParameter(String name) {
                return "jsp_precompile".equals(name) ? "true" : super.getParameter(name);
              }

              @Override
              public String getQueryString() {
                return "jsp_precompile=true";
              }
            };
        javax.servlet.http.HttpServletResponseWrapper sink =
            new javax.servlet.http.HttpServletResponseWrapper(response) {
              private final java.io.PrintWriter writer =
                  new java.io.PrintWriter(new java.io.StringWriter());

              @Override
              public java.io.PrintWriter getWriter() {
                return writer;
              }

              @Override
              public javax.servlet.ServletOutputStream getOutputStream() {
                return new javax.servlet.ServletOutputStream() {
                  @Override
                  public void write(int value) {}

                  @Override
                  public boolean isReady() {
                    return true;
                  }

                  @Override
                  public void setWriteListener(javax.servlet.WriteListener listener) {}
                };
              }

              @Override
              public void setStatus(int status) {}

              @Override
              public void setContentType(String type) {}

              @Override
              public void sendError(int code, String message) throws IOException {
                throw new IOException(message);
              }

              @Override
              public void sendError(int code) throws IOException {
                throw new IOException("HTTP " + code);
              }
            };
        ClassLoader previous = context.bind(false, null);
        try {
          dispatcher.include(wrapped, sink);
        } finally {
          context.unbind(false, previous);
        }
        results.add(
            Json.map(
                "path",
                path,
                "state",
                "COMPILED",
                "durationMs",
                (System.nanoTime() - start) / 1000000));
      } catch (Exception exception) {
        results.add(Json.map("path", path, "state", "ERROR", "error", exception.getMessage()));
      }
    }
    return results;
  }

  private void discardJsps(Context context) throws Exception {
    if (context == self) throw new IllegalArgumentException("Jerry hat keine JSP-Kompilate.");
    Object value = context.getServletContext().getAttribute(ServletContext.TEMPDIR);
    if (!(value instanceof java.io.File)) throw new IllegalStateException("Kein Work-Verzeichnis.");
    Path work = ((java.io.File) value).toPath().toAbsolutePath().normalize();
    Path tomcatWork =
        Paths.get(System.getProperty("catalina.base"), "work").toAbsolutePath().normalize();
    if (!work.startsWith(tomcatWork) || work.equals(tomcatWork))
      throw new IllegalStateException("Externes Work-Verzeichnis wird nicht automatisch gelöscht.");
    context.stop();
    try {
      if (Files.exists(work)) deleteTree(work, tomcatWork);
    } finally {
      context.start();
    }
  }

  private static void deleteTree(Path path, Path allowedRoot) throws IOException {
    Path root = allowedRoot.toRealPath(), target = path.toRealPath();
    if (!target.startsWith(root) || target.equals(root))
      throw new SecurityException("Ungültiges Löschziel.");
    Files.walkFileTree(
        path,
        new java.nio.file.SimpleFileVisitor<Path>() {
          @Override
          public java.nio.file.FileVisitResult visitFile(
              Path file, java.nio.file.attribute.BasicFileAttributes attrs) throws IOException {
            Files.delete(file);
            return java.nio.file.FileVisitResult.CONTINUE;
          }

          @Override
          public java.nio.file.FileVisitResult postVisitDirectory(Path dir, IOException error)
              throws IOException {
            if (error != null) throw error;
            Files.delete(dir);
            return java.nio.file.FileVisitResult.CONTINUE;
          }
        });
  }

  public List<Map<String, Object>> certificates() throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    String trust =
        System.getProperty(
            "javax.net.ssl.trustStore",
            Paths.get(System.getProperty("java.home"), "lib/security/cacerts").toString());
    readStore(
        result,
        "System truststore",
        Paths.get(trust),
        System.getProperty("javax.net.ssl.trustStorePassword", "changeit"),
        System.getProperty(
            "javax.net.ssl.trustStoreType", java.security.KeyStore.getDefaultType()));
    for (Connector connector : engine.getService().findConnectors()) {
      org.apache.tomcat.util.net.SSLHostConfig[] hosts =
          connector.getProtocolHandler().findSslHostConfigs();
      for (org.apache.tomcat.util.net.SSLHostConfig host : hosts) {
        for (org.apache.tomcat.util.net.SSLHostConfigCertificate certificate :
            host.getCertificates()) {
          String file = certificate.getCertificateKeystoreFile();
          if (file != null)
            readStore(
                result,
                connector.getPort() + " / " + host.getHostName(),
                resolveBase(file),
                certificate.getCertificateKeystorePassword(),
                certificate.getCertificateKeystoreType());
          else {
            String pem = certificate.getCertificateFile();
            if (pem != null)
              try (InputStream input = Files.newInputStream(resolveBase(pem))) {
                for (java.security.cert.Certificate cert :
                    java.security.cert.CertificateFactory.getInstance("X.509")
                        .generateCertificates(input))
                  if (cert instanceof java.security.cert.X509Certificate)
                    result.add(
                        certificateRow(
                            connector.getPort() + " / " + host.getHostName(),
                            "PEM",
                            (java.security.cert.X509Certificate) cert));
              }
          }
        }
        String store = host.getTruststoreFile();
        if (store != null)
          readStore(
              result,
              connector.getPort() + " truststore",
              resolveBase(store),
              host.getTruststorePassword(),
              host.getTruststoreType());
      }
    }
    return result;
  }

  private static Path resolveBase(String file) {
    Path path = Paths.get(file);
    return path.isAbsolute() ? path : Paths.get(System.getProperty("catalina.base")).resolve(path);
  }

  private void readStore(
      List<Map<String, Object>> target, String name, Path file, String password, String type) {
    char[] chars = password == null ? null : password.toCharArray();
    try (InputStream input = Files.newInputStream(file)) {
      java.security.KeyStore store =
          java.security.KeyStore.getInstance(
              type == null ? java.security.KeyStore.getDefaultType() : type);
      store.load(input, chars);
      for (String alias : Collections.list(store.aliases())) {
        java.security.cert.Certificate cert = store.getCertificate(alias);
        if (cert instanceof java.security.cert.X509Certificate)
          target.add(certificateRow(name, alias, (java.security.cert.X509Certificate) cert));
      }
    } catch (Exception exception) {
      target.add(Json.map("store", name, "error", exception.getMessage()));
    } finally {
      if (chars != null) Arrays.fill(chars, '\0');
    }
  }

  private Map<String, Object> certificateRow(
      String store, String alias, java.security.cert.X509Certificate certificate) throws Exception {
    byte[] hash =
        java.security.MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
    StringBuilder fingerprint = new StringBuilder();
    for (byte b : hash) fingerprint.append(String.format("%02X:", b & 255));
    return Json.map(
        "store",
        store,
        "alias",
        alias,
        "subject",
        certificate.getSubjectX500Principal().getName(),
        "issuer",
        certificate.getIssuerX500Principal().getName(),
        "notBefore",
        certificate.getNotBefore().getTime(),
        "notAfter",
        certificate.getNotAfter().getTime(),
        "serial",
        certificate.getSerialNumber().toString(16),
        "sha256",
        fingerprint.substring(0, fingerprint.length() - 1),
        "algorithm",
        certificate.getSigAlgName());
  }

  public List<Map<String, Object>> loggers(String app) throws Exception {
    List<Map<String, Object>> result = new ArrayList<>();
    ClassLoader previousLoader = Thread.currentThread().getContextClassLoader();
    try {
      Thread.currentThread()
          .setContextClassLoader(
              app == null || app.isEmpty() || "system".equals(app)
                  ? engine.getParentClassLoader()
                  : context(app).getLoader().getClassLoader());
      java.util.logging.LogManager manager = java.util.logging.LogManager.getLogManager();
      for (String name : Collections.list(manager.getLoggerNames())) {
        java.util.logging.Logger logger = manager.getLogger(name);
        if (logger != null)
          result.add(
              Json.map(
                  "name",
                  name,
                  "level",
                  logger.getLevel() == null ? null : logger.getLevel().getName(),
                  "framework",
                  "JUL"));
      }
    } finally {
      Thread.currentThread().setContextClassLoader(previousLoader);
    }
    if (app == null || app.isEmpty() || "system".equals(app)) return result;
    Context context = context(app);
    ClassLoader loader = context.getLoader().getClassLoader();
    try {
      Class<?> factory = Class.forName("org.slf4j.LoggerFactory", true, loader);
      Object loggingContext = factory.getMethod("getILoggerFactory").invoke(null);
      Object loggers = loggingContext.getClass().getMethod("getLoggerList").invoke(loggingContext);
      for (Object logger : (List<?>) loggers)
        result.add(
            Json.map(
                "name",
                logger.getClass().getMethod("getName").invoke(logger),
                "level",
                String.valueOf(logger.getClass().getMethod("getLevel").invoke(logger)),
                "framework",
                "Logback"));
    } catch (ClassNotFoundException | NoSuchMethodException ignored) {
    }
    try {
      Class<?> manager = Class.forName("org.apache.logging.log4j.LogManager", true, loader);
      Object loggingContext =
          manager
              .getMethod("getContext", ClassLoader.class, boolean.class)
              .invoke(null, loader, false);
      Object loggers = loggingContext.getClass().getMethod("getLoggers").invoke(loggingContext);
      for (Object logger : (java.util.Collection<?>) loggers)
        result.add(
            Json.map(
                "name",
                logger.getClass().getMethod("getName").invoke(logger),
                "level",
                String.valueOf(logger.getClass().getMethod("getLevel").invoke(logger)),
                "framework",
                "Log4j2"));
    } catch (ClassNotFoundException | NoSuchMethodException ignored) {
    }
    try {
      Class<?> manager = Class.forName("org.apache.log4j.LogManager", true, loader);
      Enumeration<?> loggers = (Enumeration<?>) manager.getMethod("getCurrentLoggers").invoke(null);
      while (loggers.hasMoreElements()) {
        Object logger = loggers.nextElement();
        result.add(
            Json.map(
                "name",
                logger.getClass().getMethod("getName").invoke(logger),
                "level",
                String.valueOf(logger.getClass().getMethod("getLevel").invoke(logger)),
                "framework",
                "Log4j1"));
      }
    } catch (ClassNotFoundException | NoSuchMethodException ignored) {
    }
    return result;
  }

  public void loggerLevel(String app, String framework, String name, String level)
      throws Exception {
    if (!Arrays.asList(
            "INHERIT", "OFF", "FATAL", "ERROR", "WARN", "INFO", "DEBUG", "TRACE", "ALL", "SEVERE",
            "WARNING", "CONFIG", "FINE", "FINER", "FINEST")
        .contains(level)) throw new IllegalArgumentException("Ungültiger Logger-Level.");
    if ("JUL".equals(framework)) {
      ClassLoader previous = Thread.currentThread().getContextClassLoader();
      try {
        Thread.currentThread()
            .setContextClassLoader(
                app == null || "system".equals(app)
                    ? engine.getParentClassLoader()
                    : context(app).getLoader().getClassLoader());
        java.util.logging.Logger logger =
            java.util.logging.LogManager.getLogManager().getLogger(name);
        if (logger == null) throw new IllegalArgumentException("Logger existiert nicht.");
        logger.setLevel("INHERIT".equals(level) ? null : java.util.logging.Level.parse(level));
        return;
      } finally {
        Thread.currentThread().setContextClassLoader(previous);
      }
    }
    ClassLoader loader = context(app).getLoader().getClassLoader();
    if ("Logback".equals(framework)) {
      Object lc =
          Class.forName("org.slf4j.LoggerFactory", true, loader)
              .getMethod("getILoggerFactory")
              .invoke(null);
      Object logger = lc.getClass().getMethod("getLogger", String.class).invoke(lc, name);
      Class<?> type = Class.forName("ch.qos.logback.classic.Level", true, loader);
      Object value =
          "INHERIT".equals(level)
              ? null
              : type.getMethod("toLevel", String.class).invoke(null, level);
      logger.getClass().getMethod("setLevel", type).invoke(logger, value);
    } else if ("Log4j2".equals(framework)) {
      Class<?> type = Class.forName("org.apache.logging.log4j.Level", true, loader);
      Object value =
          "INHERIT".equals(level)
              ? null
              : type.getMethod("valueOf", String.class).invoke(null, level);
      Object loggingContext =
          Class.forName("org.apache.logging.log4j.LogManager", true, loader)
              .getMethod("getContext", ClassLoader.class, boolean.class)
              .invoke(null, loader, false);
      Object logger =
          loggingContext
              .getClass()
              .getMethod("getLogger", String.class)
              .invoke(loggingContext, name);
      logger.getClass().getMethod("setLevel", type).invoke(logger, value);
    } else if ("Log4j1".equals(framework)) {
      Class<?> loggerType = Class.forName("org.apache.log4j.Logger", true, loader),
          levelType = Class.forName("org.apache.log4j.Level", true, loader);
      Object logger = loggerType.getMethod("getLogger", String.class).invoke(null, name);
      Object value =
          "INHERIT".equals(level)
              ? null
              : levelType.getMethod("toLevel", String.class).invoke(null, level);
      loggerType.getMethod("setLevel", levelType).invoke(logger, value);
    } else throw new IllegalArgumentException("Nicht unterstütztes Logging-System.");
  }

  private boolean wrapperAvailable() {
    try {
      Class.forName("org.tanukisoftware.wrapper.WrapperManager");
      return true;
    } catch (ClassNotFoundException ignored) {
      return false;
    }
  }

  public Map<String, Object> wrapperStatus() {
    if (!wrapperAvailable()) return Json.map("available", false);
    try {
      Class<?> type = Class.forName("org.tanukisoftware.wrapper.WrapperManager");
      return Json.map(
          "available",
          true,
          "controlled",
          type.getMethod("isControlledByNativeWrapper").invoke(null),
          "version",
          type.getMethod("getVersion").invoke(null));
    } catch (Exception exception) {
      return Json.map("available", false, "error", exception.getMessage());
    }
  }

  public void restartJvm() throws Exception {
    if (!config.bool("wrapper.restart.enabled", false))
      throw new SecurityException("JVM-Neustart ist nicht freigegeben.");
    Class.forName("org.tanukisoftware.wrapper.WrapperManager").getMethod("restart").invoke(null);
  }

  @Override
  public void close() {
    for (Map.Entry<Host, RequestMetricsValve> entry : valves.entrySet()) {
      entry.getKey().getPipeline().removeValve(entry.getValue());
      try {
        entry.getValue().stop();
        entry.getValue().destroy();
      } catch (Exception ignored) {
      }
    }
    valves.clear();
    Enumeration<java.sql.Driver> drivers = java.sql.DriverManager.getDrivers();
    while (drivers.hasMoreElements()) {
      java.sql.Driver driver = drivers.nextElement();
      if (driver.getClass().getClassLoader() == getClass().getClassLoader())
        try {
          java.sql.DriverManager.deregisterDriver(driver);
        } catch (java.sql.SQLException ignored) {
        }
    }
  }
}
