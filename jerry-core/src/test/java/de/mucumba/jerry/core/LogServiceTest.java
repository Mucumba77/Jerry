package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class LogServiceTest {
  @TempDir Path directory;

  @Test
  void pagesAndTailDoNotLoseLinesAtByteBoundary() throws Exception {
    Path logs = directory.resolve("logs");
    Files.createDirectories(logs);
    Path file = logs.resolve("app.log");
    Files.write(file, "eins\nzwei\ndrei\n".getBytes(StandardCharsets.UTF_8));
    System.setProperty("jerry.data.dir", directory.resolve("data").toString());
    System.setProperty("jerry.logs.roots", logs.toString());
    try {
      Config config = new Config();
      try (LogService service = new LogService(config, new Audit(config))) {
        String id = String.valueOf(service.files().get(0).get("id"));
        Map<String, Object> first = service.read(id, 0, 1, "UTF-8", null, null);
        Map<String, Object> next =
            service.read(
                id,
                ((Number) first.get("next")).longValue(),
                1,
                "UTF-8",
                String.valueOf(first.get("identity")),
                null);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) next.get("lines");
        assertEquals("zwei", rows.get(0).get("text"));
        String outside =
            Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString("0:../outside.log".getBytes(StandardCharsets.UTF_8));
        assertThrows(Exception.class, () -> service.read(outside, 0, 1, "UTF-8", null, null));
      }
    } finally {
      System.clearProperty("jerry.data.dir");
      System.clearProperty("jerry.logs.roots");
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"UTF-8", "UTF-16LE"})
  void followingWaitsForAnIncompleteLineAndItsSplitCharacter(String encoding) throws Exception {
    Path logs = Files.createDirectory(directory.resolve("logs"));
    Path file = logs.resolve("active.log");
    Charset charset = Charset.forName(encoding);
    byte[] complete = "old line\nGrüße\r\nnext line\n".getBytes(charset);
    int split = "old line\nGr".getBytes(charset).length + 1;
    Files.write(file, Arrays.copyOf(complete, split));
    System.setProperty("jerry.data.dir", directory.resolve("data").toString());
    System.setProperty("jerry.logs.roots", logs.toString());
    System.setProperty("jerry.config", directory.resolve("absent.properties").toString());
    try {
      Config config = new Config();
      try (LogService service = new LogService(config, new Audit(config))) {
        String id = String.valueOf(service.files().get(0).get("id"));
        Map<String, Object> preview = service.read(id, -1, 50, encoding, null, null);
        long cursor = ((Number) preview.get("followCursor")).longValue();
        assertEquals("old line\n".getBytes(charset).length, cursor);
        String identity = (String) preview.get("identity");
        Map<String, Object> waiting = service.read(id, cursor, 50, encoding, identity, null, true);
        assertEquals(cursor, waiting.get("next"));
        assertEquals(0, ((List<?>) waiting.get("lines")).size());

        Files.write(
            file, Arrays.copyOfRange(complete, split, complete.length), StandardOpenOption.APPEND);
        Map<String, Object> next = service.read(id, cursor, 50, encoding, identity, null, true);
        List<?> lines = (List<?>) next.get("lines");
        assertEquals(2, lines.size());
        assertEquals("Grüße", ((Map<?, ?>) lines.get(0)).get("text"));
        assertEquals("next line", ((Map<?, ?>) lines.get(1)).get("text"));
        assertEquals((long) complete.length, next.get("next"));
      }
    } finally {
      System.clearProperty("jerry.data.dir");
      System.clearProperty("jerry.logs.roots");
      System.clearProperty("jerry.config");
    }
  }

  @Test
  void readsGzipArchiveAndSearchesMultipleFiles() throws Exception {
    Path logs = directory.resolve("logs");
    Files.createDirectories(logs);
    try (GZIPOutputStream output =
        new GZIPOutputStream(Files.newOutputStream(logs.resolve("app.1.log.gz")))) {
      output.write(
          "2026-10-20 10:00:00 ERROR boom\n  at example.method(Test.java:1)\n"
              .getBytes(StandardCharsets.UTF_8));
    }
    System.setProperty("jerry.data.dir", directory.resolve("data").toString());
    System.setProperty("jerry.logs.roots", logs.toString());
    try {
      Config config = new Config();
      try (LogService service = new LogService(config, new Audit(config))) {
        String id = String.valueOf(service.files().get(0).get("id"));
        Map<String, Object> page = service.read(id, 0, 100, "UTF-8", null, null);
        assertTrue(String.valueOf(page.get("lines")).contains("boom"));
        String search =
            service.startSearch(
                "alice",
                "alice",
                Json.map("files", java.util.Collections.singletonList(id), "query", "boom"));
        Map<String, Object> status = null;
        for (int i = 0; i < 100; i++) {
          status = service.searchStatus("alice", search);
          if ("DONE".equals(status.get("state"))) break;
          Thread.sleep(10);
        }
        assertEquals("DONE", status.get("state"));
        assertTrue(String.valueOf(status.get("hits")).contains("boom"));
        assertThrows(IllegalArgumentException.class, () -> service.searchStatus("bob", search));
      }
    } finally {
      System.clearProperty("jerry.data.dir");
      System.clearProperty("jerry.logs.roots");
    }
  }
}
