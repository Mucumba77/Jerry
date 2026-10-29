package de.mucumba.jerry.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.Map;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Records security-relevant administration and SQL actions without writing credentials or result
 * data.
 */
public final class Audit {
  private final Path directory;

  public Audit(Config config) throws IOException {
    directory = config.dataDirectory.resolve("audit");
    Files.createDirectories(directory);
  }

  public synchronized void event(String user, String action, String target, String outcome) {
    try {
      Path file = directory.resolve("audit.jsonl");
      if (Files.exists(file) && Files.size(file) > 10L * 1024 * 1024) {
        for (int i = 4; i >= 1; i--) {
          Path old = directory.resolve("audit." + i + ".jsonl");
          if (Files.exists(old))
            Files.move(
                old,
                directory.resolve("audit." + (i + 1) + ".jsonl"),
                StandardCopyOption.REPLACE_EXISTING);
        }
        Files.move(file, directory.resolve("audit.1.jsonl"), StandardCopyOption.REPLACE_EXISTING);
      }
      Map<String, Object> row =
          Json.map(
              "time",
              System.currentTimeMillis(),
              "user",
              user,
              "action",
              action,
              "target",
              target,
              "outcome",
              outcome);
      Files.write(
          file,
          (Json.MAPPER.writeValueAsString(row) + "\n").getBytes(StandardCharsets.UTF_8),
          StandardOpenOption.CREATE,
          StandardOpenOption.APPEND);
    } catch (IOException exception) {
      Logger.getLogger("Jerry.audit").log(Level.SEVERE, "Audit write failed", exception);
    }
  }

  public static String fingerprint(String text) {
    try {
      byte[] digest =
          MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
      StringBuilder out = new StringBuilder();
      for (byte b : digest) out.append(String.format("%02x", b & 255));
      return out.toString();
    } catch (java.security.NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
