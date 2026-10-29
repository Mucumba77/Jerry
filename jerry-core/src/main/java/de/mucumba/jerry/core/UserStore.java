package de.mucumba.jerry.core;

import com.fasterxml.jackson.core.type.TypeReference;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Only editor drafts and explicit query history are stored here; result data is never included. */
public final class UserStore {
  private final Path directory;

  public UserStore(Config config) throws IOException {
    directory = config.dataDirectory.resolve("users");
    Files.createDirectories(directory);
  }

  public synchronized Map<String, Object> load(String user) throws IOException {
    Path file = directory.resolve(Audit.fingerprint(user) + ".json");
    return Files.exists(file)
        ? Json.MAPPER.readValue(file.toFile(), new TypeReference<Map<String, Object>>() {})
        : Json.map("scripts", new ArrayList<>(), "history", new ArrayList<>());
  }

  public synchronized void save(String user, Map<String, Object> state) throws IOException {
    byte[] bytes = Json.MAPPER.writeValueAsBytes(state);
    if (bytes.length > 2 * 1024 * 1024)
      throw new IllegalArgumentException("Persönlicher Speicher überschreitet 2 MB.");
    for (String key : new String[] {"scripts", "history"}) {
      Object value = state.get(key);
      if (!(value instanceof List) || ((List<?>) value).size() > 200)
        throw new IllegalArgumentException("Maximal 200 Einträge pro Liste.");
    }
    Path file = directory.resolve(Audit.fingerprint(user) + ".json"),
        temporary = directory.resolve(Audit.fingerprint(user) + ".tmp");
    Files.write(temporary, bytes);
    try {
      Files.move(
          temporary, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    } catch (java.nio.file.AtomicMoveNotSupportedException ignored) {
      Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
    }
  }
}
