package de.mucumba.jerry.testenv;

import de.mucumba.jerry.instrumentation.JerryMonitor;
import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import javax.naming.InitialContext;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.sql.DataSource;

/** A local-only fixture used to exercise the application bridge on each Tomcat family. */
public final class PlatformFixture extends HttpServlet {
  @Override
  protected void doGet(HttpServletRequest request, HttpServletResponse response)
      throws IOException {
    try {
      DataSource raw = (DataSource) new InitialContext().lookup("java:comp/env/jdbc/JerryDemo");
      DataSource monitored = JerryMonitor.dataSource(getServletContext(), raw);
      try (Connection connection = monitored.getConnection();
          Statement statement = connection.createStatement()) {
        statement.execute("SELECT 1");
        if ("error".equals(request.getParameter("action")))
          try {
            statement.execute("SELECT * FROM JERRY_TEST_MISSING");
          } catch (SQLException expected) {
          }
      }
      JerryMonitor.Scope scope = JerryMonitor.begin(getServletContext(), "HTTP_OUTBOUND", "GET");
      scope.finish(200);
      response.setContentType("application/json");
      response.getWriter().write("{\"ok\":true}");
    } catch (Exception exception) {
      throw new IOException(exception);
    }
  }
}
