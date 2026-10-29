# Contributing

1. Use a JDK 8, Maven 3.9 and Node.js 22 or later. Run `sh build.sh` or `./build.ps1` on Windows.
2. Keep the Java source compatible with Java 8 and format Java changes with Google Java Format. Add English Javadoc for public APIs and explain non-obvious concurrency, security and lifecycle decisions in code.
3. Add meaningful tests for changed behavior, especially transaction boundaries, application classloaders, monitoring overhead, authentication and shutdown. Test container-specific changes against the applicable Tomcat families; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. Keep translated UI strings in all locale catalogs consistent. Never translate user data, SQL source, URLs, credentials, class names or protocol identifiers. Machine-assisted translations need human review, particularly for security and destructive actions.
5. Do not commit credentials, live logs, database files, `.tools`, generated WARs or local IDE settings. Third-party assets and dependencies must retain their notices and licenses.

Please describe the observed problem, the effect of the change, supported platform versions, and the tests run in each pull request.
