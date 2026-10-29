package de.mucumba.jerry.core;

import static org.junit.jupiter.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

class SqlSplitterTest {
  @Test
  void literalsAndCommentsDoNotBreakStatements() {
    List<String> sql =
        SqlSplitter.split(
            "SELECT ';', 'a'';b'; -- a;b\n/* outer /* nested; */ */ SELECT 2;", "standard");
    assertEquals(2, sql.size());
    assertTrue(sql.get(0).contains("a'';b"));
  }

  @Test
  void postgresDollarQuotedFunctionRemainsWhole() {
    assertEquals(
        2,
        SqlSplitter.split(
                "CREATE FUNCTION a() RETURNS void AS $fn$ BEGIN PERFORM 1; END; $fn$ LANGUAGE plpgsql; SELECT 2;",
                "postgresql")
            .size());
  }

  @Test
  void mysqlCustomDelimiter() {
    assertEquals(
        2,
        SqlSplitter.split(
                "DELIMITER $$\nCREATE PROCEDURE x() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nSELECT 'x;';",
                "mysql")
            .size());
  }

  @Test
  void oracleBlockAndAlternativeQuoting() {
    List<String> parts =
        SqlSplitter.split("BEGIN\n x := q'[x;y]';\nEND;\n/\nSELECT 1 FROM DUAL;", "oracle");
    assertEquals(2, parts.size());
    assertTrue(parts.get(0).endsWith("END;"));
  }

  @Test
  void sqlServerBracketEscapesAndBatchSeparator() {
    assertEquals(2, SqlSplitter.split("SELECT [a;b]]c]\nGO\nSELECT 2;", "sqlserver").size());
  }

  @Test
  void rejectsUnclosedInputBeforeExecution() {
    assertThrows(
        IllegalArgumentException.class,
        () -> SqlSplitter.split("INSERT INTO a VALUES ('broken); SELECT 2;", "standard"));
  }

  @Test
  void commentsOnlyAreNotStatements() {
    assertThrows(
        IllegalArgumentException.class, () -> SqlSplitter.split("-- hi\n/* only */", "standard"));
  }

  @Test
  void sqlServerProcedureUsesGoBoundary() {
    assertEquals(
        2,
        SqlSplitter.split(
                "CREATE PROCEDURE p AS BEGIN SELECT 1; SELECT 2; END;\nGO\nSELECT 3;", "sqlserver")
            .size());
  }

  @Test
  void postgresEscapeStringDoesNotSplit() {
    assertEquals(2, SqlSplitter.split("SELECT E'a\\';b'; SELECT 2;", "postgresql").size());
  }
}
