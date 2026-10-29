package de.mucumba.jerry.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Lexical script boundaries; database syntax validation remains the driver's responsibility. */
public final class SqlSplitter {
  private static final Pattern DOLLAR = Pattern.compile("\\$(?:[A-Za-z_][A-Za-z0-9_]*)?\\$");

  private SqlSplitter() {}

  public static List<String> split(String script, String dialect) {
    if (script == null || script.trim().isEmpty())
      throw new IllegalArgumentException("SQL ist leer.");
    boolean oracle = "oracle".equalsIgnoreCase(dialect);
    boolean sqlserver = "sqlserver".equalsIgnoreCase(dialect);
    boolean mysql = "mysql".equalsIgnoreCase(dialect) || "mariadb".equalsIgnoreCase(dialect);
    List<String> result = new ArrayList<>();
    StringBuilder current = new StringBuilder();
    String delimiter = ";";
    String dollar = null;
    char quote = 0;
    char oracleClose = 0;
    int commentDepth = 0;
    boolean lineComment = false;
    boolean lineStart = true;
    boolean plsql = false;
    boolean backslashQuote = false;
    for (int i = 0; i < script.length(); ) {
      char c = script.charAt(i), n = i + 1 < script.length() ? script.charAt(i + 1) : 0;
      if (lineStart && quote == 0 && dollar == null && commentDepth == 0 && !lineComment) {
        int end = script.indexOf('\n', i);
        if (end < 0) end = script.length();
        String line = script.substring(i, end).trim();
        if (mysql && line.toUpperCase(Locale.ROOT).startsWith("DELIMITER ")) {
          if (hasSql(current.toString()))
            throw new IllegalArgumentException("DELIMITER muss zwischen Statements stehen.");
          delimiter = line.substring(10).trim();
          if (delimiter.isEmpty() || delimiter.length() > 10 || delimiter.matches(".*\\s.*"))
            throw new IllegalArgumentException("Ungültiger DELIMITER.");
          current.setLength(0);
          i = end < script.length() ? end + 1 : end;
          continue;
        }
        if ((sqlserver && line.equalsIgnoreCase("GO")) || (oracle && line.equals("/"))) {
          add(result, current);
          plsql = false;
          i = end < script.length() ? end + 1 : end;
          continue;
        }
      }
      lineStart = c == '\n';
      if (lineComment) {
        current.append(c);
        i++;
        if (c == '\n') lineComment = false;
        continue;
      }
      if (commentDepth > 0) {
        current.append(c);
        i++;
        if (c == '/' && n == '*') {
          current.append(n);
          i++;
          commentDepth++;
        } else if (c == '*' && n == '/') {
          current.append(n);
          i++;
          commentDepth--;
        }
        continue;
      }
      if (dollar != null) {
        if (script.startsWith(dollar, i)) {
          current.append(dollar);
          i += dollar.length();
          dollar = null;
        } else {
          current.append(c);
          i++;
        }
        continue;
      }
      if (oracleClose != 0) {
        current.append(c);
        i++;
        if (c == oracleClose && n == '\'') {
          current.append(n);
          i++;
          oracleClose = 0;
        }
        continue;
      }
      if (quote != 0) {
        current.append(c);
        i++;
        if (backslashQuote && c == '\\' && i < script.length()) {
          current.append(script.charAt(i++));
          continue;
        }
        char close = quote == '[' ? ']' : quote;
        if (c == close) {
          if (n == close) {
            current.append(n);
            i++;
          } else quote = 0;
        }
        continue;
      }
      if (c == '-' && n == '-') {
        current.append("--");
        i += 2;
        lineComment = true;
        continue;
      }
      if (mysql && c == '#') {
        current.append(c);
        i++;
        lineComment = true;
        continue;
      }
      if (c == '/' && n == '*') {
        current.append("/*");
        i += 2;
        commentDepth = 1;
        continue;
      }
      if (oracle && (c == 'q' || c == 'Q') && n == '\'' && i + 2 < script.length()) {
        char open = script.charAt(i + 2);
        int pair = "[({<".indexOf(open);
        oracleClose = pair >= 0 ? "])}>".charAt(pair) : open;
        current.append(script, i, i + 3);
        i += 3;
        continue;
      }
      if (c == '\'' || c == '"' || c == '`' || (sqlserver && c == '[')) {
        quote = c;
        backslashQuote =
            mysql
                || (c == '\''
                    && "postgresql".equalsIgnoreCase(dialect)
                    && i > 0
                    && (script.charAt(i - 1) == 'e' || script.charAt(i - 1) == 'E')
                    && (i < 2 || !Character.isJavaIdentifierPart(script.charAt(i - 2))));
        current.append(c);
        i++;
        continue;
      }
      if (c == '$' && !mysql) {
        Matcher match = DOLLAR.matcher(script);
        match.region(i, script.length());
        if (match.lookingAt()) {
          dollar = match.group();
          current.append(dollar);
          i += dollar.length();
          continue;
        }
      }
      if ((oracle || sqlserver)
          && !plsql
          && current.length() < 200
          && (Character.isWhitespace(c) || c == ';')) {
        String start = stripComments(current.toString()).trim().toUpperCase(Locale.ROOT);
        plsql =
            oracle
                ? start.matches("(?s)^(DECLARE|BEGIN)\\b.*")
                    || start.matches(
                        "(?s)^CREATE\\s+(OR\\s+REPLACE\\s+)?(EDITIONABLE\\s+|NONEDITIONABLE\\s+)?(PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE\\s+BODY)\\b.*")
                : start.matches(
                    "(?s)^(CREATE\\s+(OR\\s+ALTER\\s+)?|ALTER\\s+)(PROC(?:EDURE)?|FUNCTION|TRIGGER)\\b.*");
      }
      if (!plsql && script.startsWith(delimiter, i)) {
        add(result, current);
        i += delimiter.length();
        continue;
      }
      current.append(c);
      i++;
    }
    if (quote != 0 || dollar != null || oracleClose != 0 || commentDepth > 0)
      throw new IllegalArgumentException(
          "Nicht abgeschlossene Zeichenkette oder Kommentar im SQL-Skript.");
    add(result, current);
    if (result.isEmpty()) throw new IllegalArgumentException("Keine SQL-Statements gefunden.");
    if (result.size() > 200)
      throw new IllegalArgumentException("Maximal 200 Statements pro Ausführung.");
    return result;
  }

  private static String stripComments(String sql) {
    return sql.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("(?m)--[^\\r\\n]*", " ");
  }

  private static boolean hasSql(String sql) {
    return !stripComments(sql).trim().isEmpty();
  }

  private static void add(List<String> result, StringBuilder current) {
    String sql = current.toString().trim();
    if (hasSql(sql)) result.add(sql);
    current.setLength(0);
  }
}
