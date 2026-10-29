# Jerry – ausführliche Referenz

> Diese Referenz beschreibt die Funktionen der ursprünglichen Tomcat-8.5-Ausgabe. Für aktuelle Plattformen, Paketnamen, Sprachunterstützung und Versionen gilt die [aktuelle README](../README.md).

Eigenständige Verwaltungs- und Monitoringanwendung für **Java 8 und Apache Tomcat 8.5**, ausgeliefert als `jerry.war`. PSI Probe dient ausschließlich als Funktionsreferenz. Es wird kein Probe-Quellcode, keine Probe-Bibliothek und keine Probe-Oberfläche eingebunden.

## Installation

1. `dist/jerry.war` nach `$CATALINA_BASE/webapps/jerry.war` kopieren.
2. Einem Tomcat-Benutzer die Rolle `jerry-admin` zuweisen. Beispiel: [docs/tomcat-users.example.xml](docs/tomcat-users.example.xml). **Es gibt kein eingebautes Benutzerkonto und kein Standardpasswort.** Ein vorhandener Realm (etwa LDAP) kann dieselben Rollen liefern.
3. Tomcat starten und `http(s)://SERVER:PORT/jerry/` öffnen. Die Anmeldung erfolgt über den Tomcat-Realm.

Die WAR enthält `META-INF/context.xml` mit `privileged="true"`. Falls für Jerry bereits eine externe Context-Datei besteht oder die automatische Context-Konfiguration abgeschaltet ist, [docs/jerry.xml](docs/jerry.xml) als `$CATALINA_BASE/conf/Catalina/localhost/jerry.xml` verwenden. Der Tomcat-Benutzer braucht Schreibrechte auf das Jerry-Datenverzeichnis und Leserechte auf die freigegebenen Logs.

Für HTTPS-Terminierung am Reverse Proxy müssen `scheme`, `secure`, `proxyName`/`proxyPort` beziehungsweise die vorhandene `RemoteIpValve` so konfiguriert sein, dass Tomcat die ursprüngliche Verbindung korrekt erkennt.

Die technische Startprüfung erfolgte auf **Temurin 8u504 und Tomcat 8.5.100 unter Windows**. Weitere Tomcat-8.5-Patchstände und die konkreten JDBC-, Logger- und Clusteranbieter gehören zum Anwendungstest in der Zielumgebung. Tomcat 8.5 ist eine vom Benutzer vorgegebene Legacy-Zielplattform.

Eine separat startbare lokale Instanz mit Beispielanwendung, JNDI-Pool, H2-Testdaten und Archivlogs ist in [docs/TESTUMGEBUNG.md](docs/TESTUMGEBUNG.md) beschrieben. Sie ist unter `http://127.0.0.1:16850/jerry/` erreichbar, solange sie gestartet ist; die Testskripte liegen unter `scripts/testenv/`.

## Oberfläche und Funktionen

- Dashboard mit aktueller Heap-, CPU-, Thread- und Requestauslastung.
- JVM-Speicherpools, Non-Heap, Buffer-Pools, GC-Zähler und Historie.
- Connectoren, gemeinsame Executor-Pools, aktive Requestprozessoren und Request-Histogramme.
- Anwendungen über virtuelle Hosts und parallele Deployment-Versionen hinweg; Start, Stop, Reload, WAR-Upload, Undeployment und vorhandene Context-Deskriptoren.
- Servlet- und Filter-Mappings, Context-Attribute, Initialisierungsparameter und Konfigurationsquellen.
- Sessions suchen, Attribute untersuchen/entfernen und mehrere Sessions beenden; einfache Größenabschätzungen.
- JSP-Quellen, generierte Servlet-Quellen, Einzel-/Mehrfachkompilierung, Vorkompilierung beim Deployment und Verwerfen der Kompilate.
- Datenquellen über lokale/globale JNDI-Ressourcen sowie explizite JDBC-Konfiguration; grafische Poolauslastung mit belegten, freien und maximalen Connections (Aktualisierung alle fünf Sekunden), Verbindungstest und unterstützte Pool-Resets.
- SQL-Arbeitsplatz mit CodeMirror, Syntax-Highlighting, mehreren Tabs, Metadaten, Skripten, Historie und CSV-Export.
- Log-Explorer für aktuelle, rotierte und komprimierte Dateien, Live-Tail, Suche über mehrere Dateien, Stacktraces und Downloads.
- Threads, Deadlocks, Stacktraces, Cluster, Zertifikate, Systemeigenschaften und Quick Check.
- Helles und dunkles, neutrales Design mit lokal eingebundener Onest-Schrift, Tastaturbedienung, responsiven Ansichten und rollenabhängigen Aktionen.

Die Zuordnung zum Plan und zur Probe-Referenz steht in [docs/FUNKTIONSMATRIX.md](docs/FUNKTIONSMATRIX.md).

## Rollen

| Rolle | Berechtigung |
| --- | --- |
| `jerry-viewer` | Monitoring, Anwendungsübersicht, Poolinformationen und Logs lesen |
| `jerry-operator` | Zusätzlich Anwendungsdetails, Sessions, JSP-Kompilierung und Start/Stop/Reload |
| `jerry-sql` | SQL-Zugriff mit den Rechten der verwendeten Datenbankverbindung |
| `jerry-sql-read` | SQL ausschließlich über explizit konfigurierte Datenquellen mit `readOnlyEnforced=true` |
| `jerry-admin` | Alle Funktionen einschließlich Deployment, Undeployment, Konfiguration, Zertifikaten und Logger-Leveln |

Rollen können kombiniert werden. Der Lesemodus allein vertraut nicht auf `Connection.setReadOnly`: `readOnlyEnforced=true` muss eine **tatsächlich in der Datenbank schreibgeschützte Benutzerkennung** bezeichnen. Bei gewöhnlichen Anwendungs-JNDI-Verbindungen steht diese Rolle deshalb nicht zur Verfügung.

## Konfiguration

Jerry liest beim Start die optionale UTF-8-Datei `$CATALINA_BASE/conf/jerry.properties`. Eine vollständige Vorlage mit allen Grenzen steht in [docs/jerry.properties.example](docs/jerry.properties.example).

- Andere Konfigurationsdatei: `-Djerry.config=/absoluter/pfad/jerry.properties`.
- Einzelwerte übersteuern: `-Djerry.data.dir=/absoluter/pfad`.
- Werte aus Umgebungsvariablen lesen: `datasource.reporting.password=env:JERRY_REPORTING_PASSWORD`.
- Standarddatenverzeichnis: `$CATALINA_BASE/data/jerry`.
- Standard-Logverzeichnis: `$CATALINA_BASE/logs`; mehrere Wurzeln werden mit `|` getrennt.
- In Windows-Konfigurationswerten `/` verwenden, z. B. `C:/Tomcat/logs`.

Es ist keine externe Datenbank und kein weiterer Laufzeitdienst für Jerry erforderlich. Für JDBC-Verbindungen vorhandene JNDI-Ressourcen nutzen oder passende **Java-8-kompatible** JDBC-Treiber im gemeinsamen Tomcat-Verzeichnis `$CATALINA_BASE/lib` installieren. Treiber und Zugangsdaten gehören nicht in das Release.

## SQL-Verhalten

Jeder verbundene Tab besitzt eine eigene serverseitige JDBC-Verbindung. **Autocommit ist beim Öffnen aus.** Eine neue HTTP-Anfrage öffnet keine neue Transaktion auf einer anderen Verbindung. Mehrere Statements laufen nacheinander auf derselben Verbindung. Standardmäßig stoppt ein Skript beim ersten Fehler; anschließend ist ein Rollback oder die Rückkehr zu einem Savepoint erforderlich. Ein offener Transaktionszustand wird konservativ auch nach SELECTs angezeigt.

Commit, Rollback, Savepoints, Isolation und Autocommit werden über die Werkzeugleiste gesteuert. Autocommit lässt sich während einer offenen Transaktion nicht umschalten. Ein Skriptauftrag hat eine eindeutige `requestId`; dieselbe ID wird in einer SQL-Sitzung nicht erneut an die Datenbank gesendet. Nach einem Netzwerkfehler den Status prüfen, bevor eine neue Ausführung gestartet wird.

DDL, Prozeduren und Datenbankfunktionen können abhängig vom Datenbanksystem implizit committen. Ausgeschaltetes Autocommit garantiert deshalb keine allgemeine Rückrollbarkeit jedes beliebigen SQL-Skripts. Verbindungen werden nach Sitzungsablauf, Logout und beim expliziten Schließen zurückgerollt und freigegeben; aktive Transaktionen überleben keinen Serverneustart. Standard: fünf Minuten Inaktivität, maximal 15 Minuten offene Transaktion. Das reine Anzeigen eines Tabs verlängert die Frist nicht.

Unterstützte Skriptgrenzen: Semikolons außerhalb von Literalen/Kommentaren, PostgreSQL-Dollar- und E-Quoting, Oracle-PL/SQL mit `/` auf eigener Zeile, SQL-Server-Prozedurbatches mit `GO`, MySQL/MariaDB mit `DELIMITER`. `GO n`, SQL*Plus-/psql-Metabefehle und XA-verteilte Transaktionen sind kein Bestandteil des Editors. Datenbankdialekte werden durch den JDBC-Produktnamen gewählt. In Oracle und SQL Server führt Strg+Enter ohne Auswahl den ganzen Editor aus; eine Auswahl grenzt die Ausführung ein.

Ergebnisse liegen in begrenzten UTF-8-Dateien mit einem sparsamen Positionsindex, nicht komplett in der HTTP-Sitzung. Die Oberfläche zeigt seitenweise Ergebnisse; der CSV-Export liest dieselben gespeicherten Zeilen und führt kein SELECT erneut aus. Grenzen und gekürzte Zellwerte werden angezeigt. Ein neuer Auftrag im selben Tab ersetzt die bisherigen Ergebnisdateien. CSV bietet Trennzeichen, Encoding, BOM, Kopfzeilen, NULL-Darstellung, optionalen Formelschutz und Datumsformate. Nicht erkannte herstellerspezifische Datumsdarstellungen bleiben unverändert.

## Monitoring und Logs

Messintervall standardmäßig zehn Sekunden. Detaildaten bleiben standardmäßig 24 Stunden, Minutenauflösungen 30 Tage erhalten, mit einem gemeinsamen Plattenlimit. Minutenwerte enthalten den letzten Zustand und zusätzlich Minimum/Maximum/Mittelwert des Heap-Verbrauchs. Lücken, Neustarts und Zähler-Resets werden nicht als negative Raten dargestellt. `—` bezeichnet einen nicht verfügbaren Wert.

Der gemeinsame Zeitraum lässt sich oben und direkt an jeder Grafik wählen: 15 Minuten, 1, 6, 12 oder 24 Stunden sowie 7 oder 30 Tage. Die Wahl bleibt lokal im Browser gespeichert und gilt für alle Diagramme. Live-Samples ergänzen jeden gewählten Zeitraum; beim Öffnen einer Monitoring-Ansicht und anschließend alle 60 Sekunden (bei 7/30 Tagen alle fünf Minuten) wird die Historie erneut geladen. Andere Ansichten lösen keine wiederholten Historienabfragen aus. Höchstens 600 historische und zusätzlich begrenzt viele Livepunkte werden angezeigt; die Auswahl kann entsprechend ausgedünnt sein. Große erkennbare Messlücken und Nullwerte unterbrechen die Linie. Zeitachsen für mehrtägige Zeiträume zeigen zusätzlich das Datum.

Grafiken sind mit Home/End und den Pfeiltasten bedienbar und bieten einen lokalen CSV-Export der angezeigten Messpunkte mit UTC-Zeitstempeln und Rohwerten. Fehlende Werte bleiben leer; ein Export ist kein vollständiger Rohdatenexport bei ausgedünnter Historie. Beschäftigte Connector-Worker werden aus unterstützten Executor-Pools gelesen und gemeinsam genutzte Pools einmal gezählt; andere Aufgaben desselben Pools können in den Wert eingehen. Nicht unterstützte Worker-Pools und unvollständige Summen bleiben als `—` erkennbar.

Jerry registriert eine eigene Valve pro virtuellem Host und entfernt sie beim Undeployment. Sie misst echte Request-Abschlüsse inklusive asynchroner Requests. p95/p99 sind logarithmische Histogramm-Obergrenzen seit Aktivierung der Valve; die Requestprozessor-Liste ist eine Momentaufnahme. Replikationszähler werden aus unterstützten Cluster-Managern gelesen; Cluster- und Poolwerte hängen von den vorhandenen Tomcat-/Anbieterfunktionen ab.

Logs werden ausschließlich innerhalb der freigegebenen Wurzeln gelesen. Pfad- und Symlink-Ausbrüche sind gesperrt. ISO-Zeitstempel und JULI-Zeitstempel werden erkannt; zusätzliche Muster können konfiguriert werden. Thread-/Loggerfilter verwenden erkennbare Ereignisfelder und deren mehrzeilige Fortsetzungen. GZIP-Dateien werden für die Ansicht begrenzt entpackt; die dateiübergreifende Suche liest sie direkt und ist zeit-/ergebnisbegrenzt. Live-Tail betrifft aktuelle unkomprimierte Dateien. Die Dateiansicht zeigt bis zu 2.000 Zeilen im Browser.

Logger-Level werden für JUL sowie vorhandene Logback-/Log4j-Implementierungen über die Zielanwendung angesprochen. Pool-Reset, Loggeränderungen, Clusterwerte und Wrapper-Neustart sind anbieterabhängig; fehlende Unterstützung wird als solche gemeldet. Erzwungenes Thread-Beenden und Wrapper-Neustart sind standardmäßig ausgeschaltet.

## Build

Voraussetzungen: JDK 8, Maven 3.9.x, Node.js 22 oder neuer für den Frontend-Build. Im laufenden Tomcat wird Node.js nicht benötigt.

Windows:

```powershell
$env:JAVA_HOME = 'C:/Pfad/zum/jdk8'
./build.ps1
```

Linux/macOS:

```sh
export JAVA_HOME=/pfad/zum/jdk8
./build.sh
```

Manuell:

```sh
cd frontend
npm ci
npm run build
cd ..
mvn clean verify
```

Ergebnis: `jerry-web/target/jerry.war`; die Build-Skripte kopieren es zusätzlich nach `dist/jerry.war` und erzeugen eine SHA-256-Prüfsumme. Das Windows-Skript erstellt zusätzlich das vollständige Release-Paket und das Quellarchiv. Für den eigenen Anwendungstest sind keine Entwicklungswerkzeuge nötig.

Die automatisierten Kernprüfungen decken Transaktionen, Besitzprüfung, Wiederholungsschutz, Skriptgrenzen, UTF-8-Paging, CSV, Pfadgrenzen und GZIP-Logs ab. Sie ersetzen den vorgesehenen Anwendungstest mit den tatsächlichen Datenbanken, Loggern und Clusterkonfigurationen nicht.

## Projektaufbau

| Modul | Verantwortung |
| --- | --- |
| `jerry-core` | SQL, Logs, Metriken, Konfiguration, Audit und persönlicher Speicher |
| `jerry-tomcat85` | Catalina-Adapter, Request-Valve, Deployment und Ressourcenzugriff |
| `jerry-web` | Servlet-API, Authentifizierungsgrenzen, CSRF, Berechtigungen und Live-Ereignisse |
| `frontend` | React/TypeScript, CodeMirror, Tabellen, Diagramme und Oberflächenkomponenten |

Konfiguration und Benutzerdaten liegen außerhalb der WAR. Auditereignisse enthalten Benutzer, Aktion, Ziel und Ergebnis; SQL wird darin nur durch SHA-256-Fingerabdrücke referenziert. Persönliche SQL-Historie und explizit gespeicherte Skripte enthalten hingegen den eingegebenen SQL-Text und können in der Oberfläche gelöscht werden. Zur Sicherung reicht das konfigurierte Datenverzeichnis zusammen mit der externen Konfiguration. Ergebnisdateien sind temporär und werden bei einem Neustart verworfen.

Abhängigkeiten und Lizenzen: [NOTICE.md](NOTICE.md); das Release enthält zusätzlich die erzeugten Abhängigkeits- und Lizenzdateien. Die Referenzdateien in einem eventuell vorhandenen lokalen `.reference`-Verzeichnis sind weder Build-Eingabe noch Teil der Auslieferung.

## Betriebsarten pro Anwendung

Unter **Anwendungen → Anwendung → Monitoring** kann ein Administrator die Erfassung umschalten; Operatoren können sie lesen. Alle Änderungen erfordern CSRF-Schutz und werden auditiert. Die Anwendungsübersicht zeigt die aktuelle Betriebsart.

| Betriebsart | Erfassung | Lebensdauer |
|---|---|---|
| Basis | Gemeinsame JVM-, Request-, Connector- und vorhandene Poolmetriken; keine zusätzlichen Operationen/Detailereignisse | Standard für alle Anwendungen |
| Erweitert | HTTP-Laufzeiten je Methode/Servlet, Fehler, Histogramm-Obergrenzen P95/P99; lokale Quartz-Jobs, Fehler und Misfires; vorhandene Spring-Kontexte, JMS-Listener, TaskExecutoren und Hibernate-Statistik | Explizit pro Anwendung; Freischaltung bleibt nach Neustart erhalten |
| Diagnose | Erweitert plus begrenzte HTTP-Einzelmessungen: 1 % erfolgreicher Requests und Fehler bevorzugt | 10–900 Sekunden, danach automatisch vorherige Basis/Erweitert-Einstellung; manueller Abbruch möglich |

Diagnosen verwenden eine monotone Uhr. Browser-Polling verlängert sie nicht; nach einem Neustart werden sie nicht fortgesetzt. Maximal zwei Anwendungen dürfen gleichzeitig in Diagnose sein. Ein expliziter Betriebsartwechsel startet ein neues Messfenster; bestehende Tomcat-/JVM-Zähler bleiben erhalten. Automatisches Diagnoseende erhält die aggregierten Zähler, sofern Erweitert die vorherige Betriebsart war. Einstellungen liegen in `data.dir/monitoring-profiles.json`; dort stehen nur die dauerhaft erweiterten Anwendungs-IDs.

Die zusätzliche Erfassung schreibt im Request-/Quartz-Pfad weder Dateien noch Datenbankdaten und führt keine Netzwerkaufrufe aus. Grenzen standardmäßig: 64 Operationsgruppen, 100 HTTP-Ereignisse und 100 Quartz-Ereignisse je Anwendung, eine gemeinsame Warteschlange mit 256 Ereignissen. Bei Überfüllung werden Details verworfen oder durch neuere ersetzt und der Verlust angezeigt; die Anwendung wartet nicht auf einen freien Detailpuffer. Es werden keine Request-URLs, Parameter, Header, Bodies, SQL-Texte oder JMS-Payloads gespeichert. Globale Live-Messwerte werden gemeinsam gesammelt; Komponenten-Snapshots werden unabhängig von der Browseranzahl alle zehn Sekunden gelesen.

Komponentenscans verwenden zwei isolierte Daemon-Worker, höchstens 16 wartende Scans, maximal 64 gleichzeitig untersuchte Anwendungen, 16 Spring-Kontexte und 256 bereits initialisierte Singletons je Scan. Das Zeitbudget (standardmäßig 1 s) wird zwischen Zugriffen geprüft. Ein blockierender fremder Getter lässt sich nicht sicher abbrechen; er belegt höchstens einen der zwei Worker, wird als begrenzt gemeldet und für diese Anwendung nicht parallel erneut gestartet. Request-Zähler und Diagnoseablauf bleiben davon unabhängig. Thread-Listen werden ohne Stacktraces aktualisiert; ein Stacktrace wird ausdrücklich beim Öffnen angefordert.

Die Reflexionsadapter erkennen Spring-WebApplicationContexts und unterstützte initialisierte Singletons. Sie erzeugen keine Lazy Beans und aktivieren keine Hibernate-Statistik. Quartz-Historie beginnt erst mit der Listener-Anmeldung; Ausführungen/Misfires betreffen diesen JVM-Knoten, keine globale Clusterhistorie. Listener werden bei Basis, Reload/Undeployment und Jerry-Shutdown entfernt; eine nicht unterstützte Registrierung wird im Snapshot als `listenersAttached=false` gemeldet.

Unter **Anwendungen → Anwendung → JMX** können Administratoren zugeordnete lokale MBeans und einfache Attribute ausdrücklich lesen. Hibernate erkennt auch Spring-Hibernate- und Spring-JPA-FactoryBeans. Die Connector-Ansicht enthält Up-/Download-Kurven und Transfermengen je Connector; der SQL-Browser wählt das aktuelle Verbindungsschema automatisch vor. Einrichtung, Beispiele und Grenzen: [Monitoring-Anbindung](docs/MONITORING-ANBINDUNG.md).

JMS zeigt lokale Spring-Listenerzustände und Consumerzahlen, **keine Broker-Queue-Tiefe**. Jerry startet keinen ActiveMQ-Broker und öffnet keine eigene JMS-Verbindung. Laufzeiten einzelner JMS-Send-/Receive-Aufrufe, SQL-Aufrufe und ausgehender SOAP-/REST-Aufrufe benötigen zusätzliche Instrumentierung innerhalb der Anwendung; diese Adapter sind nicht Bestandteil dieser Betriebsarten. Eingehende Webservices werden wie andere HTTP-Servlets gezählt. Nicht erkannte Komponenten erscheinen als nicht verfügbar. Ein produktiver Overhead-Prozentsatz muss mit der konkreten Anwendung gemessen werden; der Test enthält einen funktionalen Parallelrequest-Test in allen Betriebsarten, keinen belastbaren Produktionsbenchmark.
