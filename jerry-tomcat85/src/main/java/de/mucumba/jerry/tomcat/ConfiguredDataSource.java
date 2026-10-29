package de.mucumba.jerry.tomcat;

import de.mucumba.jerry.core.Config;
import java.io.PrintWriter;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.SQLException;
import java.util.Properties;
import java.util.logging.Logger;
import javax.sql.DataSource;

/** Explicit driver instance avoids DriverManager registrations and redeployment leaks. */
final class ConfiguredDataSource implements DataSource {
  private final Config config;
  private final String prefix;

  ConfiguredDataSource(Config config, String name) {
    this.config = config;
    prefix = "datasource." + name + ".";
  }

  @Override
  public Connection getConnection() throws SQLException {
    return getConnection(config.get(prefix + "user", ""), config.get(prefix + "password", ""));
  }

  @Override
  public Connection getConnection(String username, String password) throws SQLException {
    try {
      String driver = config.get(prefix + "driver", "");
      if (driver.isEmpty()) throw new SQLException("JDBC-Treiberklasse ist nicht konfiguriert.");
      Driver instance =
          (Driver)
              Class.forName(driver, true, ConfiguredDataSource.class.getClassLoader())
                  .getDeclaredConstructor()
                  .newInstance();
      Properties properties = new Properties();
      properties.setProperty("user", username);
      properties.setProperty("password", password);
      String url = config.get(prefix + "url", "");
      properties.setProperty("connectTimeout", url.startsWith("jdbc:postgresql:") ? "15" : "15000");
      properties.setProperty("loginTimeout", "15");
      properties.setProperty(
          "socketTimeout", url.startsWith("jdbc:postgresql:") ? "120" : "120000");
      properties.setProperty("oracle.net.CONNECT_TIMEOUT", "15000");
      properties.setProperty("oracle.jdbc.ReadTimeout", "120000");
      Connection connection = instance.connect(url, properties);
      if (connection == null) throw new SQLException("JDBC-Treiber akzeptiert die URL nicht.");
      return connection;
    } catch (ReflectiveOperationException exception) {
      throw new SQLException(
          "JDBC-Treiber kann nicht geladen werden: " + exception.getMessage(), exception);
    }
  }

  @Override
  public PrintWriter getLogWriter() {
    return null;
  }

  @Override
  public void setLogWriter(PrintWriter writer) {}

  @Override
  public void setLoginTimeout(int seconds) {}

  @Override
  public int getLoginTimeout() {
    return 15;
  }

  @Override
  public Logger getParentLogger() {
    return Logger.getLogger("Jerry.jdbc");
  }

  @Override
  public <T> T unwrap(Class<T> type) throws SQLException {
    if (type.isInstance(this)) return type.cast(this);
    throw new SQLException("Nicht unterstützt.");
  }

  @Override
  public boolean isWrapperFor(Class<?> type) {
    return type.isInstance(this);
  }
}
