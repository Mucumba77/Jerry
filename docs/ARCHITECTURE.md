# Architecture and platform compatibility

## Modules and lifecycle

`jerry-core` contains container-independent services for monitoring profiles, metrics, logs, JDBC workspaces, threshold rules and audit events. `jerry-tomcat85` implements the Tomcat integration using Catalina APIs. Despite its historical module name, the same source is built for the supported Tomcat families and adapted to Jakarta during distribution. `jerry-web` owns authentication, CSRF checks, session cleanup, the JSON API and server-sent monitoring events. `jerry-instrumentation` is an optional library that an application explicitly installs around its own clients and data sources. The React frontend and login assets are bundled in the WAR.

The `JerryRuntime` owns collectors and closes them on undeploy. Background work uses bounded queues and daemon threads. Diagnostic mode uses a monotonic deadline, limited event buffers and a sampling rate; it is not restored after a restart. A per-application bridge communicates across webapp classloaders through JDK interfaces, only while that application opts into extended or diagnostic monitoring. The bridge and instrumentation JAR must be from the same major version.

Pool collection samples previously observed resources without borrowing connections. SQL workspaces are bound to a user session and a single physical JDBC lease; a closed workspace rolls back uncommitted work. User-provided SQL, credentials, request bodies and messages are not recorded by the instrumentation adapters. See [instrumentation.md](instrumentation.md) for the precise scope and limits.

## Platform artifacts

The canonical Java source compiles against Java 8 and the Java EE Servlet API used by Tomcat 8.5 and 9. The official Apache Tomcat Jakarta migration tool transforms servlet references and descriptors for Tomcat 10 and 11. Separate WAR files contain an `Implementation-Version` and a `Jerry-Target-Tomcat` manifest entry. The generic version is not an assurance that every Tomcat patch level or third-party pool has been tested.

Three optional adapter variants are built:

| Adapter | Servlet API | JMS API |
| --- | --- | --- |
| `jerry-instrumentation-2.1.1-javax.jar` | `javax.servlet` | `javax.jms` |
| `jerry-instrumentation-2.1.1-jakarta.jar` | `jakarta.servlet` | `jakarta.jms` |
| `jerry-instrumentation-2.1.1-jakarta-servlet-javax-jms.jar` | `jakarta.servlet` | `javax.jms` |

The Jakarta WAR offers the Jakarta adapter by default and includes the legacy-JMS variant separately. JMS monitoring is client-side; Jerry does not require a broker and does not report broker queue depth. The HTTP adapter measures until response headers, not full body consumption. Spring version compatibility and provider-specific interfaces must be verified in the target application.

## Tests

The Maven reactor runs unit tests with Java 8. `scripts/testenv/platforms.ps1` starts disposable loopback-only Tomcat fixtures and checks login, pool access, SQL, monitoring profiles and the application bridge on Tomcat 8.5/Java 8, 9.0/Java 8, 10.0/Java 8, 10.1/Java 11 and 11.0/Java 17. `scripts/testenv/verify-modern-adapter.ps1` tests Spring 6 HTTP and Jakarta JMS compatibility on Java 17. The independent Tomcat 8.5 fixture and regression checks are documented in [TESTUMGEBUNG.md](TESTUMGEBUNG.md). Tests use synthetic data and are not production performance benchmarks.

## Localization

The frontend uses local JSON catalogs in `frontend/src/locales`. German source strings are catalog keys; date and number formatting uses the selected locale. `scripts/generate-login-locales.cjs` derives the unauthenticated login catalog from the same files. A missing translation falls back to German. Driver-provided and dynamically constructed server messages can remain in their original language. Do not send application data to translation services at runtime.
