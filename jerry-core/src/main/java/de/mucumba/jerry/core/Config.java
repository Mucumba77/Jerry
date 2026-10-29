package de.mucumba.jerry.core;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

/** Loads Jerry configuration and resolves its private runtime data and log directories. */
public final class Config {
  private final Properties properties = new Properties();
  public final Path dataDirectory;
  public final Path configurationFile;

  public Config() throws IOException {
    Path base = Paths.get(System.getProperty("catalina.base", ".")).toAbsolutePath().normalize();
    configurationFile =
        Paths.get(
                System.getProperty(
                    "jerry.config", base.resolve("conf/jerry.properties").toString()))
            .toAbsolutePath()
            .normalize();
    if (Files.exists(configurationFile))
      try (java.io.Reader in =
          Files.newBufferedReader(configurationFile, java.nio.charset.StandardCharsets.UTF_8)) {
        properties.load(in);
      }
    dataDirectory =
        Paths.get(get("data.dir", base.resolve("data/jerry").toString()))
            .toAbsolutePath()
            .normalize();
    Files.createDirectories(dataDirectory);
    try {
      Files.setPosixFilePermissions(
          dataDirectory, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
    } catch (UnsupportedOperationException ignored) {
      /* Windows ACLs are inherited from the configured parent. */
    }
  }

  public String get(String name, String fallback) {
    String value = System.getProperty("jerry." + name, properties.getProperty(name, fallback));
    if (value != null && value.startsWith("env:")) {
      String environment = System.getenv(value.substring(4));
      if (environment == null)
        throw new IllegalArgumentException("Umgebungsvariable fehlt: " + value.substring(4));
      return environment;
    }
    return value;
  }

  public boolean bool(String name, boolean fallback) {
    return Boolean.parseBoolean(get(name, String.valueOf(fallback)));
  }

  public int number(String name, int fallback, int min, int max) {
    try {
      return Math.max(min, Math.min(max, Integer.parseInt(get(name, String.valueOf(fallback)))));
    } catch (NumberFormatException ignored) {
      return fallback;
    }
  }

  public Properties properties() {
    Properties copy = new Properties();
    copy.putAll(properties);
    return copy;
  }

  public List<Path> logDirectories() throws IOException {
    List<Path> roots = new ArrayList<>();
    String defaultRoot =
        Paths.get(System.getProperty("catalina.base", "."), "logs").toAbsolutePath().toString();
    for (String root : get("logs.roots", defaultRoot).split("\\|")) {
      Path path = Paths.get(root.trim()).toAbsolutePath().normalize();
      if (Files.isDirectory(path)) roots.add(path.toRealPath());
    }
    return roots;
  }
}
