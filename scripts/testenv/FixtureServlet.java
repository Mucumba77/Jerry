package de.mucumba.jerry.testenv;

import java.io.IOException;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;
import javax.naming.InitialContext;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.sql.DataSource;

/** Disposable local application for testing Jerry against real Catalina objects. */
public final class FixtureServlet extends HttpServlet {
  private static final long serialVersionUID = 1L;
  private static final Logger LOG = Logger.getLogger(FixtureServlet.class.getName());
  private final AtomicLong requests = new AtomicLong();

  @Override
  protected void doGet(HttpServletRequest request, HttpServletResponse response)
      throws ServletException, IOException {
    request.setCharacterEncoding("UTF-8");
    response.setContentType("application/json;charset=UTF-8");
    String action = request.getParameter("action");
    if ("slow".equals(action)) {
      try {
        Thread.sleep(Math.min(15000, Math.max(1, Long.parseLong(request.getParameter("ms")))));
      } catch (InterruptedException exception) {
        Thread.currentThread().interrupt();
      }
    }
    request.getSession().setAttribute("visitor", "Jerry Test – Grüße aus Köln");
    request.getSession().setAttribute("requests", requests.incrementAndGet());
    if ("error".equals(action)) LOG.warning("Absichtliche Testwarnung: äöü ß €");
    int customers = 0;
    try {
      DataSource source = (DataSource) new InitialContext().lookup("java:comp/env/jdbc/JerryDemo");
      try (Connection connection = source.getConnection();
          Statement statement = connection.createStatement();
          ResultSet result = statement.executeQuery("SELECT COUNT(*) FROM TEST_CUSTOMERS")) {
        result.next();
        customers = result.getInt(1);
      }
    } catch (Exception exception) {
      throw new ServletException(exception);
    }
    response
        .getWriter()
        .write("{\"ok\":true,\"customers\":" + customers + ",\"requests\":" + requests.get() + "}");
  }
}
