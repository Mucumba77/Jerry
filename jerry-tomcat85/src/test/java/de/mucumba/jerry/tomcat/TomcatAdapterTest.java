package de.mucumba.jerry.tomcat;

import static org.junit.jupiter.api.Assertions.*;

import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class TomcatAdapterTest {
  @Test
  void localNamingRejectsExternalAndAmbiguousNames() {
    assertEquals("jdbc/Jerry Demo_雪", TomcatAdapter.localJndiName("jdbc/Jerry Demo_雪"));
    for (String name :
        Arrays.asList(
            "ldap://host/a",
            "rmi:x",
            "../jdbc/x",
            "jdbc/../x",
            "/jdbc/x",
            "jdbc//x",
            "jdbc/x/",
            "jdbc\\x",
            "jdbc/\nx",
            "")) {
      assertThrows(IllegalArgumentException.class, () -> TomcatAdapter.localJndiName(name), name);
    }
    assertThrows(IllegalArgumentException.class, () -> TomcatAdapter.localJndiName(null));
  }

  @Test
  void webResourcePathsCannotEscapeTheApplication() {
    assertEquals("/WEB-INF/web.xml", TomcatAdapter.localResourcePath("/WEB-INF/web.xml"));
    assertEquals("/views/Grüße.jsp", TomcatAdapter.localResourcePath("/views/Grüße.jsp"));
    for (String path :
        Arrays.asList(
            "../web.xml",
            "/../secret",
            "/x/../secret",
            "/x/./secret",
            "//secret",
            "/x/",
            "/x\\secret",
            "/x/\nsecret")) {
      assertThrows(
          IllegalArgumentException.class, () -> TomcatAdapter.localResourcePath(path), path);
    }
    assertThrows(IllegalArgumentException.class, () -> TomcatAdapter.localResourcePath(null));
  }

  @Test
  void countsSharedWorkerPoolOnceAndDoesNotGuessForUnknownExecutors() throws Exception {
    ThreadPoolExecutor pool =
        new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<Runnable>());
    CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
    try {
      pool.execute(
          () -> {
            entered.countDown();
            try {
              release.await();
            } catch (InterruptedException e) {
              Thread.currentThread().interrupt();
            }
          });
      assertTrue(entered.await(3, TimeUnit.SECONDS));
      assertEquals(1, TomcatAdapter.countActiveWorkers(Arrays.asList(pool, pool)));
      assertNull(TomcatAdapter.countActiveWorkers(Arrays.asList(pool, command -> command.run())));
      assertNull(TomcatAdapter.countActiveWorkers(Collections.emptyList()));
    } finally {
      release.countDown();
      pool.shutdownNow();
    }
  }
}
