# Lokale Jerry-Testumgebung

Die Testinstanz läuft unter **http://127.0.0.1:16850/jerry/** mit Apache Tomcat **8.5.100** und Temurin **Java 8u504**. HTTP und Tomcat-Shutdown sind ausschließlich an `127.0.0.1` gebunden. Es wird kein Windows-Dienst installiert. Die Instanz läuft bis zum Stoppen oder Herunterfahren des Rechners.

## Zugang

Die zufällig erzeugten lokalen Zugangsdaten stehen in `.tools/jerry-testenv/access.json`:

| Schlüssel | Konto | Rolle |
| --- | --- | --- |
| `user` / `password` | `jerry-test` | Administrator |
| `viewer` / `viewerPassword` | `jerry-viewer` | Monitoring und Logs lesen |
| `reader` / `readerPassword` | `jerry-reader` | Monitoring und SQL über einen tatsächlich lesenden DB-Benutzer |

Die Datei und die Laufzeitkonfiguration liegen im ignorierten `.tools`-Verzeichnis und werden nicht ins Release gepackt. Diese Testkonten sind keine eingebauten Jerry-Konten.

## Starten, stoppen, neu deployen

Vom Projektordner in PowerShell aus:

```powershell
./scripts/testenv/start.ps1
./scripts/testenv/stop.ps1
```

Eine neu gebaute `dist/jerry.war` übernehmen:

```powershell
./scripts/testenv/stop.ps1
Copy-Item dist/jerry.war .tools/jerry-testenv/tomcat/webapps/jerry.war -Force
$config = Get-Content .tools/jerry-testenv/environment.json -Raw | ConvertFrom-Json
$config.warSha256 = (Get-FileHash dist/jerry.war -Algorithm SHA256).Hash
$config | ConvertTo-Json | Set-Content .tools/jerry-testenv/environment.json -Encoding utf8
./scripts/testenv/start.ps1
```

`setup.ps1` erwartet lokal Tomcat unter `.tools/apache-tomcat-8.5.100`, das JDK unter `.tools/java8/jdk8u504-b01` und H2 2.2.224 im lokalen Maven-Repository. Alle drei Pfade lassen sich mit `-TomcatHome`, `-JavaHome` und `-H2Jar` übergeben; HTTP- und Shutdown-Port mit `-Port` und `-ShutdownPort`. Die hier eingerichtete Umgebung enthält diese Voraussetzungen bereits. Das Setup ersetzt die Testkonfiguration, setzt die vier Beispieldatensätze zurück und behält Zugangsdaten, Monitoringhistorie und persönliche SQL-Skripte. Es verweigert die Einrichtung, solange die registrierte Instanz läuft.

Tomcat-Installation und Laufzeit sind getrennt:

- `CATALINA_HOME`: `.tools/apache-tomcat-8.5.100`
- `CATALINA_BASE`: `.tools/jerry-testenv/tomcat`
- Start-/Fehlerausgabe: `.tools/jerry-testenv/console.out.log` und `console.err.log`
- Instanzkonfiguration: `.tools/jerry-testenv/environment.json`

## Vorbereitete Testfälle

**Datenquellen:** `Global · jdbc/JerryDemo` ist ein echter Tomcat-JDBC-Pool gegen eine lokale H2-Dateidatenbank. Die Beispielanwendung bindet denselben Pool über einen JNDI-ResourceLink ein. `Jerry-Konfiguration · demo-reader` verbindet sich mit einem separaten H2-Benutzer, der ausschließlich SELECT-Rechte auf die beiden Testtabellen besitzt.

Im SQL-Arbeitsplatz verbinden; `PUBLIC` und dessen Tabellen werden automatisch vorgewählt. Zum Beispiel ausführen:

```sql
SELECT ID, NAME, EMAIL, BALANCE FROM TEST_CUSTOMERS ORDER BY ID;
SELECT 'Mehrere Statements; ein Skript' AS TEST;
```

Die Beispieldaten enthalten Umlaute, Semikolons, Anführungszeichen, NULL und einen Formelanfang für den CSV-Test. `TEST_TRANSACTIONS` dient für Commit-, Rollback- und Savepoint-Tests; die automatisierten Prüfungen verwenden dort IDs 9000–9010. H2 ist eine lokale Testdatenbank; damit werden Oracle-, PostgreSQL-, MySQL- oder SQL-Server-Integrationen nicht abgenommen.

**Anwendungen und Requests:** `/jerry-demo/` enthält eine JSP. `/jerry-demo/api` erzeugt eine Session mit untersuchbaren Attributen und prüft die Datenbank. `/jerry-demo/api?action=slow&ms=5000` hält einen Request fünf Sekunden aktiv, damit er unter Requestprozessoren beobachtet werden kann. `action=error` schreibt eine absichtliche Testwarnung. Der Connector verwendet einen gemeinsamen Executor, damit beide Monitoring-Ansichten Daten zeigen.

**Logs:** `demo.log`, `demo.log.1` und `demo.log.2.gz` enthalten dieselben erkennbaren Ereignisse an unterschiedlichen Tagen, mit Umlauten und einem mehrzeiligen Stacktrace. Sie können einzeln geöffnet, heruntergeladen oder gemeinsam nach `Archiv-Testfehler` durchsucht werden.

## Durchgeführte Prüfung

Am 20.10.2026 bestanden **26 automatisierte Kernprüfungen** und **39 Integrationstests** gegen die laufende Tomcat-Instanz. Die Integrationstests umfassen Authentifizierung, Rollen, CSRF, Monitoring-APIs, SSE, JNDI, Sessions/JSP-Quellen, SQL-Transaktionsisolation über zwei Verbindungen, Savepoints, Wiederholungsschutz, Rollback beim Schließen, tatsächliche Datenbank-Leserechte, CSV, Log-Rotationen/GZIP, Pfadgrenzen sowie WAR-Upload, JSP-Kompilierung, Start/Stop/Reload und Undeployment einer temporären Testanwendung.

Beim Integrationstest wurde ein Abschlussrennen im SQL-Dienst gefunden und korrigiert: Ein abgeschlossener Auftrag wird erst nach Audit und Freigabe der JDBC-Verbindung als fertig veröffentlicht. Ein gezielter Regressionstest deckt diesen Fehler ab.

Zusätzlich im Browser geprüft: Anmeldung, Live-Messwerte, Speicher-/GC- und Connector-Ansichten, SQL-Syntax-Highlighting, zwei Ergebnistabellen, CSV-Download, Rollback, historische GZIP-Logs, aufklappbarer Stacktrace und Suche über mehrere Rotationen. Der Start und der geordnete Shutdown wurden ebenfalls ausgeführt.

Die Integrationstests sind mit Node.js 22 oder neuer wiederholbar:

```powershell
node scripts/testenv/verify.cjs
```

Der Runner verwendet ausschließlich die lokale Instanz aus `environment.json`; er verändert die vorbereiteten Testtabellen und erstellt/entfernt kurzzeitig `/jerry-upload`. Ergebnisse stehen in `.tools/jerry-testenv/integration-report.json`; die zur geprüften WAR gehörende Kopie und Screenshots liegen unter `dist/testenv/`.

Diese Instanz ist ein einzelner Tomcat ohne Cluster, externen Logger-Provider oder Tanuki Wrapper. Deren Anbieterfunktionen und produktive JDBC-Treiber brauchen eigene Integrationsprüfungen.

## Connection-Pool-Anzeige

Die Datenquellenliste und ihre Detailansicht zeigen Belegt, Frei und Maximal sowie einen Kapazitätsbalken. Die Werte werden alle fünf Sekunden abgefragt. Der zusätzliche Integrationstest prüft die Werte bei zwei belegten JDBC-Verbindungen und fehlende Metriken für die direkte JDBC-Datenquelle. Im Browser wurde der Anstieg auf zwei belegte Connections und die Freigabe nach dem Schließen der SQL-Tabs geprüft. Der globale JNDI-Pool und der ResourceLink der Beispielanwendung zeigen denselben zugrunde liegenden Pool; ihre Werte dürfen nicht addiert werden.

## Gestaltung

Die Oberfläche verwendet ein neutrales Jerry-Theme mit Schiefergrau, Türkis und klaren, kompakten Flächen für Betriebsdaten. Onest wird lokal aus der WAR geladen; Schriftlizenz und Herkunft sind im Release enthalten. Login und Anwendung laden keine Schrift von externen Servern. Ein zusätzlicher Integrationstest prüft die anonym erreichbaren Login-Stile und die lokale Schriftdatei.

## Betriebsarten und Framework-Fixture

Zusätzlich verfügbar: `/jerry-framework/api`, eine echte Spring-5.3.39-/Quartz-2.3.2-Anwendung unter Java 8. Sie führt jede Sekunde einen lokalen Quartz-Job aus; jeder fünfte Lauf schlägt absichtlich fehl. Der Spring-TaskExecutor hat maximal drei Threads. Ein konfigurierter Spring-JMS-Listener ist absichtlich gestoppt (Min. 2 / Max. 4 Consumer). Es wird kein Broker gestartet oder kontaktiert. `lazyConstructed` muss auch nach dem Monitoring null bleiben.

```powershell
./scripts/testenv/framework.ps1
node scripts/testenv/verify-modes.cjs
node scripts/testenv/verify-modes.cjs prepare-restart
./scripts/testenv/stop.ps1
./scripts/testenv/start.ps1
node scripts/testenv/verify-modes.cjs check-restart
```

Das Framework-Setup baut ausschließlich eine zusätzliche Test-WAR; Spring, Quartz und JMS werden nicht in Jerry eingebunden. Die Mode-Prüfungen umfassen Basis-Gating, Rollen/CSRF, ungültige Dauern, echte Komponenten und Jobfehler, unveränderte Lazy Beans, automatisches Ende auf beide Basisarten, globale Diagnosegrenze, manuelles Ende, Sampling-Metadaten ohne Query-Parameter, je 200 Requests bei Parallelität acht in allen drei Betriebsarten sowie wiederholte Wechsel ohne doppelte Job-Listener. Der Neustarttest prüft dauerhafte Freischaltung und das Verwerfen temporärer Diagnose-Leases. Berichte: `modes-report.json` und `modes-restart-report.json` unter `.tools/jerry-testenv/`, Releasekopien unter `dist/testenv/`.

Die lokale Fixture prüft keinen tatsächlichen JMS-Nachrichtentransport oder produktiven JDBC-/Webservice-Adapter. Seit 21.10.2026 enthält sie echten Hibernate 5.6.15.Final mit Spring-JPA- und Spring-Hibernate-FactoryBeans gegen H2: JPA mit aktivierter Statistik, die klassische Factory mit absichtlich deaktivierter Statistik. Außerdem exportiert sie eine Health-MBean mit einem geschützten Passwort-Getter und eine ModelMBean mit expliziter Zuordnungsregel. `/api?download=131072` liefert zusätzlich 128 KiB Testdaten; POST `/api` liest bis zu 1 MiB Upload. Sie ist kein Nachweis eines bestimmten CPU-/Latenz-Overheads. Nach dem Neustarttest wird für die reine Framework-Fixture Erweitert aktiviert, damit die Ansicht direkt ausprobiert werden kann.

Prüfung des vorherigen Betriebsarten-Releases vom 20.10.2026: 26 Core-Tests, 39 bestehende Integrationsprüfungen, sieben Betriebsarten-Prüfgruppen und ein Neustarttest bestanden (73 automatisierte Prüfungen insgesamt). Die Browserprüfung bestätigte Login, Betriebsartenanzeige, Framework-Tabellen, den Countdown und manuellen Abbruch. Geprüfte WAR-SHA256: `D0CE81DF9FAD16E03C00D60684305EA460266064777D1CC4A7E3E9EDA55204F0`. Die damaligen Berichte beziehen sich auf diesen Hash; die Betriebsarten- und UI-Berichte dieses Standes liegen unter dist/testenv/previous-monitoring-release/.


UI-Korrektur vom 20.10.2026: Komponentenabschnitte besitzen einheitliche Fluchten, Abstände und kurze Erklärungen. Auch Laufzeiten, Quartz-Historie und HTTP-Diagnose sind beschrieben. Die Dashboard-Anwendungen verlinken für Operatoren und Administratoren auf die jeweiligen Anwendungsdetails und sind per Tastatur erreichbar. 26 Core-Tests und 39 Integrationsprüfungen bestanden. Im Browser wurden beide Dashboard-Navigationsarten, alle fünf Abschnittsfluchten (jeweils x=299 für Überschrift, Erklärung, Filter und erste Spalte) sowie die Beschreibungen geprüft. Damals geprüfte WAR-SHA256: `4A3DE303D668EF3C58C6C9DDE9D7FFA3CA1A035993CA8C84B93DEA3A77C917D3`. Aktuelle Nachweise: dist/testenv/integration-report.json, ui-report.json, layout-measurements.json und die zugehörigen Screenshots. Die Backend-Betriebsarten wurden für diese reine UI-Änderung nicht erneut geprüft.


Ansichtsübergreifende UI-Prüfung vom 20.10.2026: Einheitliche Panel- und Dialog-Innenabstände; separate kurze Funktionsbeschreibungen ergänzen vorhandene Zähler-/Zeitangaben. SQL und Logs verwenden einheitliche Fluchten innerhalb ihrer Werkzeugspalten. Zwölf Hauptansichten und acht Anwendungsreiter wurden in der laufenden Instanz geprüft. Messprotokoll: dist/testenv/all-views-layout.json. Zusätzlich wurden ein SELECT mit anschließendem Rollback und Schließen des SQL-Tabs, ein GZIP-Archiv mit Suchfiltern, JSP-Quellen und der Deployment-Dialog geprüft. Es wurden keine Logger geändert oder Verwaltungsaktionen ausgelöst. 26 Core-Tests und 39 Integrationsprüfungen bestanden. Damals geprüfte WAR-SHA256: `E5A106B0F02B2A76032FDCA59FCEC49328E890B8A09DE341C4A2BC8D4626F3B4`. Die damaligen Integrations- und UI-Berichte samt Screenshots sind unter dist/testenv/previous-transfer-release-E5A106B0 gesichert. Weitere ältere UI-Nachweise bleiben unter previous-ui-layout erhalten.

## JMX, Hibernate, Transfer und Schemaauswahl – 21.10.2026

Am 21.10.2026 geprüfte WAR-SHA256: `D560EF14B92188EB7F0CFB0CE90509D51F17AB92ACB678FB251819E76E3804DF`. Die zugehörigen Nachweise liegen unter `dist/testenv/previous-20261021-D560EF14/`.

**83 automatisierte Prüfungen bestanden:** 29 Java-Core-Tests, drei Tests der Transferberechnung, 39 bestehende Integrationstests, vier neue Integrationsgruppen, sieben Betriebsarten-Gruppen und ein Neustarttest. Die neuen Gruppen prüfen automatische und explizite JMX-Zuordnung, Adminrechte und fremde Bean-IDs, unterdrückte Passwort-Getter, echte Spring-JPA-/Hibernate-FactoryBeans mit aktivierter bzw. deaktivierter Statistik, unveränderte Lazy Beans, das vorgewählte JNDI-Verbindungsschema und echte Upload-/Download-Byte-Zähler. Core-Tests prüfen ein vom Benutzer abweichendes Standardschema und Schema-Namen mit Unterstrich, Metadatenfilter ohne Schemaänderung sowie Connector-Epochen bei Reset/Entfernung. Transfer-Tests prüfen ausgedünnte Verläufe, getrennte Connectoren, Epochenwechsel, fehlende Daten und unbekanntes Volumen ohne ausreichend Messpunkte.

Im Browser geprüft: JMX-Liste samt beiden Zuordnungsarten, einfache Attribute und Maskierung; zwei Hibernate-FactoryBeans mit korrektem Statistikstatus und aufklappbare Einrichtungshilfe; vorausgewähltes `PUBLIC` samt Tabellen, SELECT, Neuladen mit erhaltener offener Transaktion, erneut automatisch ermitteltes Schema, manueller Filter mit Aktualisierung, Rollback und Schließen; Transfermengen, Mittel-/Spitzenwerte und getrennte Kurven. In allen neuen Panels und den fünf Komponentenabschnitten wurden Überschrift, Beschreibung und erste Tabellenspalte auf dieselbe Textkante gemessen (x=263; rechte Chartspalte x=774 bei dieser Fenstergröße). `ui-report.json` enthält die Messungen und Screenshot-Namen.

Die Berichte dieses damaligen Stands liegen im genannten Archiv. Frühere Layoutnachweise beziehen sich ebenfalls auf ihre jeweiligen WAR-Hashes.

```powershell
node --test scripts/testenv/connector-traffic.test.mjs  # Node.js 24 für direkten TypeScript-Import
node scripts/testenv/verify-enhancements.cjs
```

Die Einrichtung der eigenen Anwendung ist in [MONITORING-ANBINDUNG.md](MONITORING-ANBINDUNG.md) beschrieben. Die Testinstanz bleibt gestartet; nur `/jerry-framework` ist für die Demonstration auf Erweitert eingestellt. Im produktiven Tomcat des Nutzers wurde nichts deployt oder geändert.

## Funktions- und Darstellungsprüfung – 26.10.2026

Aktuell geprüfte WAR-SHA256: `78325E3C52B559897411434E76B2360574902A4D56FE2FFB6E00F598C854F05C`. Diese WAR ist in der lokalen Testinstanz deployt.

Es bestanden 31 Java-Core-Tests, ein Tomcat-Adapter-Test, neun Tests der Diagramm-/Historienberechnung, 39 Integrationstests, vier zusätzliche Integrationsgruppen, sieben Zeitraumanfragen, sieben Betriebsarten-Prüfgruppen und ein Neustarttest. Der Integrationstest erzeugt mehrere parallele langsame Requests und prüft, dass der gemeinsam genutzte Executor tatsächlich beschäftigte Worker meldet. Der Adaptertest prüft die eindeutige Zählung eines mehrfach verwendeten Pools und die Kennzeichnung unbekannter Implementierungen. Ein frischer Start und der geordnete Neustart wurden mit der endgültigen WAR geprüft.

Im Browser wurden alle zwölf Hauptansichten und neun Anwendungsreiter ohne globalen horizontalen Überlauf durchgesehen. Es wurden die gemeinsam synchronisierten Auswahlen 1/12/24 Stunden und sieben Tage, aktuelle Livepunkte im Sieben-Tage-Verlauf, Datum auf mehrtägigen Achsen, Speicherung nach Neuladen und die Tastaturbedienung geprüft. Im schmalen Layout wurden der aufklappbare SQL-Datenbankbrowser, das vorgewählte Schema und die Tabellen geprüft; breite Datentabellen scrollen in ihrem eigenen Bereich. Eine tatsächliche CSV-Datei wurde während der Browserprüfung des vorherigen Build-Kandidaten kontrolliert; der endgültige CSV-Inhalt wird zusätzlich durch die neun Diagrammtests geprüft. Helles und dunkles Design, die SQL-Sitzungswiederherstellung und Tastaturaktionen wurden ebenfalls am Build-Kandidaten überprüft.

Berichte und Screenshots stehen in `dist/testenv/`: `integration-report.json`, `enhancements-report.json`, `history-report.json`, `modes-report.json`, `modes-restart-report.json`, `ui-report.json`, `release-verification.json`, `review-dashboard.png` und `review-mobile-sql.png`. Die Berichte enthalten den Hash der jeweils geprüften WAR. Details zur Funktionsprüfung und mögliche nächste Erweiterungen stehen in [FUNKTIONS-REVIEW.md](FUNKTIONS-REVIEW.md).

```powershell
node --test scripts/testenv/history-charts.test.mjs scripts/testenv/connector-traffic.test.mjs
node scripts/testenv/verify-history.cjs
```
