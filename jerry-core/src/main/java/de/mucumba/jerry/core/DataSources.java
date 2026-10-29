package de.mucumba.jerry.core;

import java.util.List;
import java.util.Map;
import javax.sql.DataSource;

/**
 * Provides the database source operations required by the SQL workspace independently of Tomcat.
 */
public interface DataSources {
  List<Map<String, Object>> list() throws Exception;

  DataSource resolve(String id) throws Exception;

  default boolean enforcedReadOnly(String id) {
    return false;
  }
}
