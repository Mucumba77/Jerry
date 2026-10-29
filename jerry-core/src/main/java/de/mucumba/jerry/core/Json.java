package de.mucumba.jerry.core;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;

/** Centralizes JSON serialization and small map/value conversion helpers. */
public final class Json {
  public static final ObjectMapper MAPPER = new ObjectMapper();

  private Json() {}

  public static Map<String, Object> map(Object... pairs) {
    Map<String, Object> result = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) result.put(String.valueOf(pairs[i]), pairs[i + 1]);
    return result;
  }

  public static String text(Map<String, Object> data, String key, String fallback) {
    Object value = data.get(key);
    return value == null ? fallback : String.valueOf(value);
  }

  public static int integer(Map<String, Object> data, String key, int fallback, int min, int max) {
    try {
      return Math.max(min, Math.min(max, Integer.parseInt(text(data, key, ""))));
    } catch (NumberFormatException ignored) {
      return fallback;
    }
  }
}
