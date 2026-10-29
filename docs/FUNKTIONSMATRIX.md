# Jerry – Umsetzung und Abnahmegrundlage

Referenz: dokumentierter PSI-Probe-Funktionsumfang für Tomcat 8.5, Funktionsmatrix vom 20.05.2023. Jerry ist eine eigene Implementierung, kein Fork. Die Tabelle dokumentiert den implementierten Lieferumfang; die Abnahme mit den Zielsystemen übernimmt der Benutzer.

| Plan / Referenzfunktion | Umsetzung | Technische Voraussetzung / bewusste Grenze |
| --- | --- | --- |
| WAR, Java 8, Tomcat 8.5 | Drei Maven-Module; `jerry.war`, Servlet 3.1 / javax | Startprüfung auf 8.5.100 / Java 8; privilegierter Context |
| Moderne Oberfläche | Eigenes React/TypeScript-Design, responsive, Hell/Dunkel, Tabellenfilter/-sortierung/-spalten | Moderner Browser |
| Contexts auflisten und verwalten | Hosts, Versionen, Start/Stop/Reload, WAR-Upload, Undeploy, vorhandene XML-Deskriptoren | HostConfig-Deployer und passende Rollen; Jerry verändert sich nicht selbst |
| Servlet-/Filter-Mappings, Parameter, Attribute | Eigene Detailansichten, Attributentfernung, Konfigurationsquellen | Containerattribute bleiben geschützt; Konfigurationsquellen nur für Admins |
| Sessions | Übersicht, Wert-/Attributsuche, letzter bekannter Client, Attribute entfernen, Einzel-/Mehrfach-Expire | Letzte IP ab Valve-Erfassung; begrenzte Objektdarstellung; maximal 5.000 angezeigte Sessions |
| Sessiongrößen | Schätzungen für Strings, primitive Wrapper und Bytearrays | Keine exakte Heap-Größe oder Serialisierung unbekannter Anwendungsobjekte |
| JSPs | Auflisten, Quelltext, generierter Code, Auswahl/alle kompilieren, beim Deployment vorkompilieren, Kompilate verwerfen | Jasper, Tomcat-Work-Verzeichnis; maximal 2.000 Kompilierungen pro Auftrag; externe Work-Verzeichnisse werden nicht gelöscht |
| Datenquellen | Globale/private JNDI-Ressourcen und direkte JDBC-Konfiguration, URL-Zuordnung, Poolwerte, Test, Reset | JDBC-Treiber und Poolanbieter; unterstützte Reset-Methode muss existieren; keine XA-Steuerung |
| Vollwertiger SQL-Arbeitsplatz im definierten Umfang | Tabs, Schema-/Tabellen-/View-/Routine-Browser, Spalten, Schlüssel, Indizes, Editor, SQL-Formatierung, Skripte, Historie | JDBC-Metadaten; derzeit maximal 5.000 Metadatenzeilen pro Abfrage |
| Transaktionen | Verbindung pro Tab, Autocommit aus, explizite Commit/Rollback/Savepoints/Isolation | Tatsächliche DDL-/Prozedursemantik bleibt datenbankabhängig |
| Mehrere Statements | Dialektbewusste Grenzen für Standard-SQL, PostgreSQL, Oracle, MySQL/MariaDB und SQL Server | Keine SQL*Plus-/psql-Metabefehle oder GO-Wiederholungszähler |
| Ergebnisse und CSV | Mehrere Resultsets, Update-Zähler, begrenzte Vorschau, Pagingindex, Export ohne Wiederholung, NULL-/BOM-/Encoding-/Datumsoptionen | SQL-Limits sind sichtbar und konfigurierbar; große Zellen können gekürzt werden |
| Abbruch, Fehler und Wiederholungen | SQL-Aufträge mit Status, Treiber-Cancel, Query-/Netzwerk-Timeout, eindeutige Request-IDs, Stop beim Fehler | Treiber müssen JDBC-Cancel/Timeout unterstützen; unbekannter Ausgang wird nicht automatisch wiederholt |
| JVM / Speicher / System | Heap, Non-Heap, Speicherpools, Peaks, GC, Buffer, Prozess-/System-CPU, RAM/Swap, Properties | JVM-/OS-abhängige Werte können fehlen |
| Historie | 15 Minuten bis 30 Tage, gemeinsame Auswahl an jeder Grafik, Livepunkte, Tastaturbedienung, CSV-Export und sichtbare Lücken | Keine Historie vor Installation; exportierte Punkte können ausgedünnt sein, UTC-Zeitstempel |
| Requestprozessoren | Phasen, URI, Methode, Laufzeit, Thread, Bytes, Client | Momentaufnahme über JMX |
| Request-Latenzen | Eigene Valve, synchrone/asynchrone Abschlüsse, Durchschnitt/Maximum und Histogramme | p95/p99 als Bucket-Obergrenzen seit Aktivierung, keine rückwirkenden Perzentile |
| Connectoren / Threadpools | Raten, Fehler, Bytes, Durchschnitt, Thread-/Verbindungszahlen, gemeinsame Executoren | Verfügbare JMX-Attribute; nicht benutzte/fehlende Werte gekennzeichnet |
| Logs | Live-Tail, ältere Rotationen, `.gz`, Mehrdateisuche, Kontext, Stacktraces, Downloads, Ausschnitt-Export | Freigegebene Wurzeln; ISO/JULI oder konfiguriertes Format; Such-/Cachelimits |
| Logger-Level | JUL und vorhandenes Logback/Log4j1/Log4j2 | Änderungen an laufender Konfiguration, anbieterspezifische Klassen erforderlich |
| Threads | Zustände, Stacks, CPU-Gesamtzeit, Locks, Deadlocks, Interrupt; optional erzwungenes Ende | Stop standardmäßig deaktiviert und nur Admin; CPU-Unterstützung JVM-abhängig |
| Cluster | Mitgliedschaft, verfügbare JMX-Attribute, Managerzähler, Replikationsraten/-historie | Cluster-/Managerimplementierung stellt Werte bereit; kein künstlicher Datenverkehr |
| Zertifikate | Systemtruststore und Connector-Key-/Truststores; PEM, Laufzeiten, SHA-256 | Vom Tomcat-Prozess lesbare Stores und konfigurierte Passwörter |
| Service Wrapper | Status und optionaler JVM-Neustart | Tanuki Wrapper muss bereits vorhanden und Neustart ausdrücklich konfiguriert sein |
| Quick Check | Adapter, Plattform, Datenverzeichnis, gestoppte Anwendungen, Deadlocks, Monitoring, SQL-Ressourcen | Manuell auslösbar, Admin |
| Zugriff / Audit | Tomcat-Realm, fünf Rollen, serverseitige Checks, CSRF, Sessionbesitz, rotierendes Audit | Keine eingebauten Zugangsdaten; keine Ergebnisdaten oder SQL-Klartexte im Audit |
| Betrieb / Upgrade | Externe Konfiguration und Daten, Bereinigung von Workern/Valves/JDBC-Leases, Buildskripte, Prüfsumme, Quellarchiv | Vor Upgrade offene SQL-Arbeit abschließen; laufende Transaktionen werden nicht migriert |

## Technischer Prüfstand der Lieferung

- Java-Kompilierung unter einem echten JDK 8.
- Automatisierte Kernprüfungen für SQL, Besitzprüfung, Wiederholungen, CSV, UTF-8-Paging und Loggrenzen.
- Produktionsbuild der TypeScript-/React-Oberfläche.
- Start der WAR auf einer isolierten Tomcat-8.5.100-Instanz mit Java 8.
- Anmeldung und Erreichbarkeit der zentralen API-Bereiche.
- Keine behauptete Abnahme gegen Oracle, PostgreSQL, SQL Server, MySQL/MariaDB, produktive Logger, Cluster oder Wrapper: diese Zielumgebungen wurden nicht bereitgestellt und gehören zum vorgesehenen Anwendungstest.

## Anwendungsbezogene Betriebsarten

| Bereich | Umsetzung | Grenze |
|---|---|---|
| Basis | Standard ohne zusätzliche Detailerfassung; JVM, native Requests, Connectoren, vorhandene Pools | Globaler Collector standardmäßig 10 s |
| Erweitert | Dauerhafte Freischaltung pro Context; Servlet-Laufzeiten, Fehler, P95/P99-Obergrenzen | 64 Operationsgruppen; Neustarts setzen Zähler zurück |
| Diagnose | Zeitlich begrenzte Einzelmessungen, Countdown, manueller Abbruch, automatische Rückkehr | Standard max. 15 min, 2 parallele Apps, 1 % erfolgreiche HTTP-Requests; begrenzte Puffer |
| Spring | Vorhandene WebApplicationContexts und initialisierte Singletons; ThreadPoolTaskExecutor | Keine Initialisierung von Lazy Beans |
| Quartz | Lokaler Schedulerstatus, Listener-Historie, Laufzeiten, Jobfehler, Misfires | Kein globaler Cluster-/JobStore-Scan; erst ab Listener-Anmeldung |
| JMS-Client | Spring-Listenerstatus, Destination, Consumerzahlen, Reconnect-Zustand | Kein Brokerzugriff, keine Queue-Tiefe, keine Send-/Receive-Latenzen |
| Hibernate | Bereits aktivierte Statistiken über direkte SessionFactory sowie Spring-Hibernate-/JPA-FactoryBeans lesen | Keine automatische Aktivierung; echte Spring-5.3-/Hibernate-5.6-Fixture geprüft |
| Anwendungs-JMX | Beans nach Classloader, Host/Context oder expliziten ObjectName-Mustern; einfache Attribute lesen | Administratoren; Platform-MBeanServer; begrenzte Abrufe ohne Polling, keine Schreib-/Operationsfunktion |
| Connector-Transfer | Upload/Download-Raten, Gesamt- und Zeitraumvolumen, Durchschnitt und Intervallspitzen pro Connector | Kumulative Tomcat-Zähler, verfügbare Historie; erkannte Reset-/Epochengrenzen werden ausgelassen |
| SQL-Standardschema | JDBC-Verbindungsschema bzw. MySQL-Katalog beim Verbinden vorwählen, Tabellen laden | Eindeutiger Benutzer-Fallback gekennzeichnet; keine automatische Schemaänderung |
| Webservices / SQL | Eingehendes HTTP über Servlet-Metriken, Datenquellen-/Poolwerte, vorhandene ORM-Zähler | Einzelne SQL-/JMS-/ausgehende SOAP-/REST-Aufrufe brauchen zusätzliche App-Instrumentierung |
| Zugriff / Aufwand | Admin-Umschaltung, Operator-Lesezugriff, Audit/CSRF; gemeinsam gecachte Komponentenwerte | Zwei Collector-Worker, Warteschlange 16, Zeit-/Mengenbudgets |
