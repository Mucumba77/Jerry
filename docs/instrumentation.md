# Optionales Monitoring von HTTP, JMS und SQL

Jerry erfasst eingehende Servlet-Requests und Quartz-Ausführungen in „Erweitert“ automatisch. Ausgehende HTTP-Aufrufe, JMS-Clients und JDBC-Aufrufe benötigen eine bewusste Einbindung **in der jeweiligen Anwendung**. Der Adapter wird mit Jerry ausgeliefert und kann auch aus der Anwendungsansicht heruntergeladen werden. Der Adapter-Bytecode ist mit Java 8 kompatibel; Servlet API, JMS API und gegebenenfalls Spring Web stellt die Anwendung selbst bereit.

Die Java-Klassen liegen ab Jerry 2.0 unter `de.mucumba.jerry.instrumentation`. Es gibt drei Adaptervarianten: `jerry-instrumentation-2.1.4-javax.jar` für Tomcat 8.5/9 und `javax.jms`, `jerry-instrumentation-2.1.4-jakarta.jar` für Tomcat 10/11 und `jakarta.jms`, sowie `jerry-instrumentation-2.1.4-jakarta-servlet-javax-jms.jar` für Jakarta-Servlets mit einem älteren `javax.jms`-Client. Die Anwendung stellt die jeweils passende Servlet- und JMS-API bereit. Nur die tatsächlich verwendete Variante einbinden; Adapter und Jerry müssen dieselbe Hauptversion haben.

Die Anwendung darf nur Clients beziehungsweise Datenquellen umschließen, die sie tatsächlich verwendet. Nach der Integration „Erweitert“ für die Anwendung einschalten; die Verbindung erscheint nach kurzer Zeit als „bereit“. In „Basis“ werden keine Detailmessungen erzeugt. In „Diagnose“ kommen für die gewählte, begrenzte Dauer stichprobenartige Einzelereignisse hinzu. Nach Ablauf gilt wieder die zuvor gewählte Basis- oder Erweitert-Betriebsart. Fehler werden bevorzugt erfasst. Ein laufender Aufruf, dessen Betriebsart gewechselt hat, wird verworfen.

## JDBC

Die DataSource vor Übergabe an Hibernate, Spring JDBC oder anderen Anwendungscode umschließen:

```java
DataSource monitored = JerryMonitor.dataSource(servletContext, existingDataSource);
// monitored als DataSource der EntityManagerFactory bzw. des JdbcTemplate konfigurieren
```

Der Adapter misst JDBC-`execute*`-Aufrufe, keine Verbindungsaufnahme oder ResultSet-Verarbeitung. Verwendet die Anwendung herstellerspezifische Interfaces, `unwrap` oder proprietäre APIs, können Aufrufe am Adapter vorbeigehen; die Kompatibilität ist für die jeweilige Anwendung zu prüfen. SQL-Texte und Parameter werden nicht gespeichert. Der Adapter selbst öffnet keine Verbindung.

## JMS

```java
ConnectionFactory monitored = JerryMonitor.connectionFactory(servletContext, existingFactory);
// monitored in den JMS-Listener-Containern und sendenden Clients verwenden
```

Gemessen werden Sendungen sowie synchrone Empfangsaufrufe und Listener-Ausführungen der umschlossenen lokalen JMS-Clients. Die Empfangsdauer bei `receive(timeout)` umfasst auch die Wartezeit. Nachrichten, Destinationen und Inhalte werden nicht gespeichert; es werden keine Broker-Metriken oder Queue-Tiefen abgefragt. Der passende Adapter unterstützt die Standard-`javax.jms`- beziehungsweise `jakarta.jms`-Interfaces; bei proprietären Casts oder Unwraps muss die Anwendungskompatibilität geprüft werden.

## Spring RestTemplate und andere HTTP-Clients

```java
RestTemplate client = new RestTemplate();
client.getInterceptors().add(new JerryHttpInterceptor(servletContext));
```

Der Interceptor misst bis zum Eingang des Response-Status, nicht bis zum vollständigen Lesen des Bodys. Für andere HTTP-Clients kann ein Scope ausdrücklich um den Aufruf gelegt werden:

```java
JerryMonitor.Scope scope = JerryMonitor.begin(servletContext, "HTTP_OUTBOUND", "GET");
try {
    // HTTP-Aufruf ausführen und danach den tatsächlichen HTTP-Status übergeben
    scope.finish(statusCode);
} catch (Exception error) {
    scope.failed();
    throw error;
}
```

Erfasst werden nur freigegebene HTTP-Methoden, Status und Laufzeit; keine URL, Header oder Inhalte. Beim Spring-Interceptor können I/O-Fehler als 500 erfasst werden. Die Anwendung muss den Adapter bei Verwendung verschiedener Clients jeweils dort einbauen.

## Schwellenwerte und Poolhistorie

Unter „System & Diagnose“ lassen sich lokale Warnregeln für Heap-Auslastung, Auslastung bereits beobachteter Pools und HTTP-Fehlerrate einstellen. Es gibt Auslöse- und Rückstellverzögerung, eine Hysterese und eine Mindestanzahl von Requests. Die Bewertung verwendet jeweils das letzte Messintervall, keine gleitende Langzeitquote. Zu wenige Requests oder fehlende Werte halten bestehende Warnungen als „Messwert derzeit nicht verfügbar“ aufrecht. Bei Regeländerungen und Neustart beginnt die Bewertung neu; die Einstellungen bleiben gespeichert. Es werden keine externen Benachrichtigungen verschickt.

Die Poolhistorie beginnt, sobald Jerry die jeweilige Datenquelle beispielsweise über die Datenquellenansicht aufgelöst hat. Jerry startet bei der Hintergrundsammlung keine zuvor unbenutzten JNDI-Ressourcen und leiht keine Datenbankverbindungen aus. Bei ResourceLinks kann derselbe Pool unter mehreren Namen erscheinen; Warnungen werden nach Möglichkeit für dasselbe Poolobjekt zusammengefasst. Einige Poolanbieter stellen nicht alle Werte bereit. Die maximale Zahl beobachteter Ressourcen ist 64; alte Daten vor dem Beginn der Beobachtung können nicht nachträglich rekonstruiert werden. Die Abtastrate lässt sich mit `monitor.pool.interval.seconds` (10–300, Standard 30) konfigurieren; die reguläre Historienaufbewahrung gilt auch für diese Werte.

Die Adapter kosten im Basisbetrieb einen kleinen lokalen Prüfaufruf. Erweitert addiert begrenzte Zähler und Histogramme für tatsächlich instrumentierte Operationen; Diagnose erfasst zusätzlich begrenzte Ereignisse. Der Aufwand hängt vom Durchsatz und den verwendeten Treibern ab. Vor Produktiveinsatz unter repräsentativer Last messen.
