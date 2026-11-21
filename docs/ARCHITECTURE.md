# Architecture and platform compatibility

## Modules and lifecycle

`jerry-core` contains container-independent services for monitoring profiles, metrics, logs, JDBC workspaces, threshold rules and audit events. `jerry-tomcat85` implements the shared Tomcat integration using Catalina APIs. `jerry-web` owns authentication, CSRF checks, session cleanup, the JSON API and server-sent monitoring events. `jerry-tomcat11` builds a Jakarta WAR with its own compiler target and container dependencies. `jerry-instrumentation` is an optional library that an application explicitly installs around its own clients and data sources. The React frontend and login assets are bundled in each WAR.

The `JerryRuntime` owns collectors and closes them on undeploy. Background work uses bounded queues and daemon threads. Diagnostic mode uses a monotonic deadline, limited event buffers and a sampling rate; it is not restored after a restart. A per-application bridge communicates across webapp classloaders through JDK interfaces, only while that application opts into extended or diagnostic monitoring. The bridge and instrumentation JAR must be from the same major version.

Pool collection reads JMX counters from registered data sources and uses available getters on previously resolved sources as a fallback. It samples without borrowing connections. SQL workspaces reserve capacity before connecting on a bounded worker pool. If an HTTP wait times out, the worker returns any connection that arrives later. An open workspace is bound to a user session and a single physical JDBC lease. Closing it rolls back uncommitted work. User-provided SQL, credentials, request bodies and messages are not recorded by the instrumentation adapters. See [instrumentation.md](instrumentation.md) for the precise scope and limits.

## Platform artifacts

The default Maven reactor compiles the shared code against Java 8 and the Java EE Servlet API for Tomcat 8.5 and 9. The Apache Jakarta migration tool transforms that WAR for Tomcat 10. The `tomcat11` Maven profile stages the shared web and Catalina sources with Jakarta Servlet imports, adds a Tomcat 11 implementation of context binding, and compiles the sources directly against Tomcat 11 with `--release 17`. It packages a Servlet 6.1 descriptor and expects Catalina, Jasper and the Servlet API from the running container.

Versioned WAR files contain the `Implementation-Version` and `Jerry-Target-Tomcat` manifest entries. The Tomcat 11 WAR also carries `Jerry-Build: native`. Shared core and instrumentation sources retain their Java 8 target.

Three optional adapter variants are built:

| Adapter | Servlet API | JMS API |
| --- | --- | --- |
| `jerry-instrumentation-2.1.5-javax.jar` | `javax.servlet` | `javax.jms` |
| `jerry-instrumentation-2.1.5-jakarta.jar` | `jakarta.servlet` | `jakarta.jms` |
| `jerry-instrumentation-2.1.5-jakarta-servlet-javax-jms.jar` | `jakarta.servlet` | `javax.jms` |

The Jakarta WAR offers the Jakarta adapter by default and includes the legacy-JMS variant separately. JMS monitoring is client-side; Jerry does not require a broker and does not report broker queue depth. The HTTP adapter measures until response headers, not full body consumption. Spring version compatibility and provider-specific interfaces must be verified in the target application.

## Tests

The distribution build runs Maven tests on Java 8 and Java 17. `scripts/testenv/platforms.ps1` starts disposable loopback-only Tomcat fixtures on Tomcat 8.5/Java 8, 9.0/Java 8, 10.0/Java 8, 10.1/Java 11 and 11.0/Java 17. It checks login, JSP compilation, pool sampling, parallel SQL connections, live log lines, monitoring profiles and the application bridge. Use `-Family tomcat85,tomcat11` to select just those two targets. The Tomcat 11 fixture also verifies the WAR manifest, Java 17 servlet bytecode and the Servlet 6.1 deployment descriptor. `scripts/testenv/verify-modern-adapter.ps1` tests Spring 6 HTTP and Jakarta JMS compatibility on Java 17. See [TESTUMGEBUNG.md](TESTUMGEBUNG.md) for the separate Tomcat 8.5 fixture.

## Localization

The frontend uses local JSON catalogs in `frontend/src/locales`. German source strings are catalog keys; date and number formatting uses the selected locale. `scripts/generate-login-locales.cjs` derives the unauthenticated login catalog from the same files. A missing translation falls back to German. Driver-provided and dynamically constructed server messages can remain in their original language. Do not send application data to translation services at runtime.
