# Changelog

## 2.1.2

- Add the Jerry mouse and monitoring logo to the application, login pages and project README.
- Center the logo above the login form and blend its sidebar variant into both themes.
- Allow the login logo to load before authentication and verify it in the Tomcat integration suite.

## 2.1.1

- Resolve JNDI data sources from current Tomcat resource declarations, rejecting URL-style or traversal names.
- Validate application resource paths and restrict JSP source access to discovered JSP files.
- Add regression checks for forged JNDI names, resource traversal and SQL-like quoted metadata identifiers.

## 2.1.0

- Added SQL completion for tables, columns, common aliases and selected dialect-specific functions. Column metadata is loaded only when needed and cached per connection and schema.
- Added a lightweight JDBC metadata request for editor completion and browser-level completion checks.

## 2.0.0

- Renamed Jerry's Java packages and Maven group to `de.mucumba.jerry`.
- Added versioned distributions for Tomcat 8.5, 9, 10.0, 10.1 and 11, including separate Jakarta and legacy JMS adapter variants.
- Introduced a neutral slate and teal theme and locally packaged interface language catalogs.
- Added platform compatibility checks, English source documentation and formatting.

**Upgrade:** recompile monitored applications against the matching 2.0 instrumentation JAR. The package names and cross-application bridge key changed; the 1.x adapter does not report telemetry to Jerry 2.0.
