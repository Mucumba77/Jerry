package de.mucumba.jerry.core;

import java.io.IOException;
import java.io.Writer;
import java.util.List;

/** Encodes JDBC results as CSV with optional spreadsheet formula protection. */
public final class Csv {
  private Csv() {}

  public static void row(
      Writer writer, List<?> values, char separator, String nullText, boolean spreadsheetSafe)
      throws IOException {
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) writer.write(separator);
      Object value = values.get(i);
      String text = value == null ? nullText : String.valueOf(value);
      if (spreadsheetSafe && text.matches("(?s)^[\\s]*[=+@-].*")) text = "'" + text;
      writer.write('"');
      writer.write(text.replace("\"", "\"\""));
      writer.write('"');
    }
    writer.write("\r\n");
  }
}
