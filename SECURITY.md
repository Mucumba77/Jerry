# Security

Jerry is a privileged Tomcat administration application with access to deployed applications, server metadata, configured logs and database resources. Deploy it only behind authenticated, encrypted administrative access and assign the minimum Tomcat and database privileges required. Keep Tomcat, Java and JDBC drivers patched; Tomcat 8.5 and 10.0 are end-of-life platforms.

Do not publish credentials, stack traces containing secrets, application data or reproducible exploits in a public issue. Use a private GitHub security advisory for this repository when available, or contact the repository owner privately with a description, affected versions and a minimal safe reproduction. Do not include production data in reports.

## Supported versions and reporting

The latest published 2.x release is the intended target for security fixes. Older releases, including 2.0.x, are not maintained as separate security branches; upgrade to the latest 2.x release where possible. This is a best-effort community project and does not guarantee response times or a particular support period. Tomcat, Java, database drivers and other runtime components are maintained separately by their respective providers.

Use [private vulnerability reporting](https://github.com/Mucumba77/Jerry/security/advisories/new) to describe the affected version, impact and minimal safe reproduction. Do not disclose details publicly before a fix and coordinated disclosure. If the form is unavailable, contact the owner privately through GitHub.

The instrumentation module compiles against Spring Web 5.3 as a `provided` dependency for Java 8 compatibility; it is not bundled into the adapter or Jerry WAR. The monitored application supplies its own Spring runtime and is responsible for keeping it supported and assessing its advisories. Do not replace the compile dependency with Spring 6 without considering that Spring 6 requires Java 17 and Jakarta APIs.

The application includes role checks, CSRF protection for state changes, bounded background workers, path restrictions for log access and masking for some sensitive JMX attributes. These measures do not replace a network boundary, least privilege or review of the data exposed by your application and JDBC drivers.
