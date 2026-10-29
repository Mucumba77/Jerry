# Changelog

## 2.1.0

- Added SQL completion for tables, columns, common aliases and selected dialect-specific functions. Column metadata is loaded only when needed and cached per connection and schema.
- Added a lightweight JDBC metadata request for editor completion and browser-level completion checks.

## 2.0.0

- Renamed Jerry's Java packages and Maven group to `de.mucumba.jerry`.
- Added versioned distributions for Tomcat 8.5, 9, 10.0, 10.1 and 11, including separate Jakarta and legacy JMS adapter variants.
- Introduced a neutral slate and teal theme and locally packaged interface language catalogs.
- Added platform compatibility checks, English source documentation and formatting.

**Upgrade:** recompile monitored applications against the matching 2.0 instrumentation JAR. The package names and cross-application bridge key changed; the 1.x adapter does not report telemetry to Jerry 2.0.
