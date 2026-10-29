# Jerry – Herkunft und Drittanbieter

Jerry wurde für dieses Projekt eigenständig implementiert. PSI Probe wurde zur Ermittlung des Funktionsumfangs betrachtet. Der lokale Referenzcheckout ist kein Bestandteil der Anwendung und wird nicht in die WAR oder das Quellarchiv übernommen.

Die Tomcat-Integration verwendet die öffentlichen Catalina-/Servlet-/Jasper-Schnittstellen und verfügbare JMX-Attribute des Zielcontainers. Tomcat-Bibliotheken haben Maven-Scope `provided`; der Zielcontainer stellt sie bereit.

Wesentliche Laufzeitabhängigkeiten:

| Bestandteil | Projekt / Lizenz |
| --- | --- |
| Apache Tomcat / Servlet-API | Apache Software Foundation; Apache License 2.0 / jeweilige API-Lizenz, vom Container bereitgestellt |
| Jackson 2.x | FasterXML; Apache License 2.0 |
| React | Meta und Mitwirkende; MIT |
| CodeMirror / Lezer | Mitwirkende; MIT |
| Lucide | Lucide-Mitwirkende; ISC |
| SQL Formatter | SQL-Formatter-Mitwirkende; MIT |
| Onest (lokal eingebundene variable Schrift) | The Onest Project Authors; SIL Open Font License 1.1; vollständiger Lizenztext unter `frontend/public/fonts/OFL.txt` und in der WAR unter `fonts/OFL.txt` |

Die genauen gebauten Versionen und kopierten Lizenztexte werden beim Verpacken in `dist/dependencies.json` und `dist/THIRD-PARTY-LICENSES.txt` erfasst. Die Frontend-Versionen sind zusätzlich in `frontend/package-lock.json` fixiert. JUnit und H2 werden ausschließlich für die automatisierten Prüfungen verwendet und nicht mit der WAR ausgeliefert.

Der Jerry-Quellcode steht unter der Apache License 2.0; der vollständige Lizenztext befindet sich in `LICENSE`. Die genannten Drittanbieter behalten ihre jeweiligen Lizenzen.
