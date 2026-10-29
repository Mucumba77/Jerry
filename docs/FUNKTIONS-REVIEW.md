# Funktions- und Darstellungsprüfung

Stand: 26.10.2026. Die Prüfung umfasst Quellcode, die laufende isolierte Java-8-/Tomcat-8.5.100-Testinstanz, zwölf Hauptansichten und neun Anwendungsreiter. Echte produktive Datenbanken, Logger, Cluster und ActiveMQ-Broker wurden dafür nicht verwendet. Die vorhandenen JNDI-/H2-, Spring-, Hibernate- und Quartz-Fixtures liefern Testdaten.

| Bereich | Ergebnis der Prüfung und Anpassung |
| --- | --- |
| Dashboard | Größere Kennzahlen und Beschriftungen; Connector-Worker aus unterstützten Pools, gemeinsam genutzte Pools nur einmal; unbekannte Werte als `—`. Diagramme mit synchroner Zeitraumwahl, Tastatur und CSV. |
| Anwendungen | Übersicht, Context, Monitoring, JMX, Servlet/Filter, Attribute, Sessions, JSP und Konfiguration durchgesehen. Tastaturaktivierung einer Tabellenaktion navigiert nicht mehr zusätzlich in die Tabellenzeile. |
| Speicher & GC | Lesbarere Werte, Achsen und Erläuterungen. Fehlende GC-Zähler werden nicht als Null oder negative Gesamtsumme ausgegeben. |
| Requestprozessoren / Threads | Ansichten, Filter und vorhandene Detailaktionen geprüft. Werte bleiben Momentaufnahmen; Stacktraces werden erst beim Öffnen geladen. |
| Connectoren / Cluster | Synchroner Zeitraum auch im Cluster, aktuelle Punkte in allen Zeiträumen, größere Diagramme. Fehlende Einzelwerte verfälschen die Connector- oder Replikationssumme nicht; gemeinsame Pools werden nicht doppelt als Connector-Threadpool dargestellt. |
| SQL-Arbeitsplatz | Datenbankbrowser auch auf schmalem Bildschirm aufklappbar. Nach Neuladen der SQL-Sitzung erscheint wieder der Datenquellenname; die offene Transaktion bleibt erhalten. |
| Datenquellen | Poolanzeige, Belegt/Frei/Maximum und JNDI-Zugriff geprüft. Direkte JDBC-Verbindungen ohne Poolzähler bleiben als nicht verfügbar erkennbar. |
| Log-Explorer | Darstellung, aktuelle und archivierte Dateien, GZIP und dateiübergreifende Suche geprüft. Protokolltexte und Zeilennummern sind größer. |
| Zertifikate / System & Diagnose | Übersichten, vorhandene Status- und Detailfunktionen geprüft; Schrift und Bedienelemente vergrößert. |
| JMX / Hibernate | Vorhandene Framework-Fixture geprüft. Die JMX-Maskierung erkennt zusätzlich Schlüssel mit Trennzeichen wie `api_key` und `private-key`, ohne deren Getter aufzurufen. Die Namensprüfung ist keine vollständige Geheimniserkennung. |
| Historie | 15 Minuten bis 30 Tage direkt an jeder Grafik und zentral auswählbar, pro Browser gespeichert. Langzeitansichten erhalten ebenfalls Livepunkte. Der letzte vorhandene Punkt wird bei begrenzter Punktzahl berücksichtigt; Ausfälle und erkannte JVM-Neustarts unterbrechen die Linie. |

Tabellen, Erklärungstexte, Logs, Schaltflächen, SQL-Editor und Diagrammachsen sind vergrößert. Tabellen dürfen innerhalb ihrer eigenen Fläche horizontal scrollen; bei 390 Pixeln Breite bleibt die Gesamtseite ohne horizontalen Überlauf. Die Auswahl der Diagrammzeiträume gilt bewusst gemeinsam für alle Grafiken. CSV enthält die tatsächlich angezeigten Messpunkte, UTC-Zeitstempel und numerische Werte. Lange Zeiträume können ausgedünnte Daten enthalten.

## Sinnvolle nächste Erweiterungen

Die folgenden Ideen sind noch nicht implementiert:

1. **Lokale Schwellenwerte und Warnungen:** einstellbare Grenzen für Heap, Fehlerquote und Poolauslastung mit Verzögerung und Hysterese, damit kurze Spitzen keine dauernden Warnungen auslösen. Zunächst als Anzeige in Jerry; externe Benachrichtigungen wären eine eigene, ausdrücklich zu konfigurierende Erweiterung.
2. **Verlauf der Connection-Pools:** gemeinsame, begrenzte Erfassung von Belegt/Frei/Maximum und Darstellung als Verlauf pro Datenquelle. Die Erfassung sollte bestehende Poolzähler lesen und keine zusätzlichen Datenbankverbindungen öffnen.
3. **Gezielte Instrumentierung für Anwendungsaufrufe:** optional Laufzeiten und Fehler ausgehender HTTP-/SOAP-Aufrufe sowie JMS- und SQL-Operationen pro Anwendung. Diese Informationen sind aus dem bisherigen Tomcat-/Spring-Zustand allein nicht zuverlässig verfügbar und benötigen Integration in der Anwendung; Sampling, Betriebsarten und Payload-Verzicht müssen dabei erhalten bleiben.
4. **Quartz-Diagnose:** nächste geplante Trigger und ungewöhnlich lange lokale Jobausführungen ergänzen, wenn der vorhandene Scheduler diese Werte effizient bereitstellt. Die Erfassung müsste begrenzt und für jede Anwendung zuschaltbar bleiben, insbesondere bei externen JobStores.

Ein belastbarer Performance-Effekt der optionalen Erweiterungen hängt von Anwendung, Treibern und Last ab und muss in der jeweiligen Zielumgebung gemessen werden.
