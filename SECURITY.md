# Security

Jerry is a privileged Tomcat administration application with access to deployed applications, server metadata, configured logs and database resources. Deploy it only behind authenticated, encrypted administrative access and assign the minimum Tomcat and database privileges required. Keep Tomcat, Java and JDBC drivers patched; Tomcat 8.5 and 10.0 are end-of-life platforms.

Do not publish credentials, stack traces containing secrets, application data or reproducible exploits in a public issue. Use a private GitHub security advisory for this repository when available, or contact the repository owner privately with a description, affected versions and a minimal safe reproduction. Do not include production data in reports.

## Supported versions and reporting

The latest published 2.x release is the intended target for security fixes. Older releases, including 2.0.x, are not maintained as separate security branches; upgrade to the latest 2.x release where possible. This is a best-effort community project and does not guarantee response times or a particular support period. Tomcat, Java, database drivers and other runtime components are maintained separately by their respective providers.

Use [private vulnerability reporting](https://github.com/Mucumba77/Jerry/security/advisories/new) to describe the affected version, impact and minimal safe reproduction. Do not disclose details publicly before a fix and coordinated disclosure. If the form is unavailable, contact the owner privately through GitHub.

The instrumentation module compiles against Spring Web 5.3 as a `provided` dependency for Java 8 compatibility; it is not bundled into the adapter or Jerry WAR. The monitored application supplies its own Spring runtime and is responsible for keeping it supported and assessing its advisories. Do not replace the compile dependency with Spring 6 without considering that Spring 6 requires Java 17 and Jakarta APIs.

The two current Spring Web dependency alerts cover [CVE-2016-1000027](https://github.com/advisories/GHSA-4wrc-f8pq-fpqp) (unsafe Java deserialization) and [CVE-2025-22233](https://spring.io/security/cve-2025-22233/) (DataBinder field restrictions). Jerry's adapter uses Spring's HTTP client interceptor interfaces, not the affected deserialization or DataBinder APIs. This observation does not establish that a monitored application's own Spring deployment is safe. The 5.3.43 fix for the latter is available through Spring enterprise support; the former's affected remoting classes were removed in Spring 6. Follow the advisories and your Spring support provider's guidance for the actual application runtime.

JDBC metadata APIs accept database names and search patterns; Jerry does not build SQL text from these inputs and escapes JDBC wildcard characters where supported. The behavior of `DatabaseMetaData` ultimately depends on the JDBC driver. Keep drivers supported and test the driver and database used in your environment. Permission checks and the database account's privileges continue to apply.

The application includes role checks, CSRF protection for state changes, bounded background workers, path restrictions for log access and masking for some sensitive JMX attributes. These measures do not replace a network boundary, least privilege or review of the data exposed by your application and JDBC drivers.
