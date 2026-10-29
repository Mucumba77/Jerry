# Anwendungen mit Jerry verbinden

## Hibernate und Spring JPA

1. Unter **Anwendungen → Anwendung → Monitoring** die Betriebsart **Erweitert** aktivieren.
2. In der überwachten Anwendung `hibernate.generate_statistics=true` konfigurieren und die Anwendung neu starten. Jerry aktiviert diese Einstellung nicht selbst. Hibernate-Statistiken verursachen zusätzlichen Aufwand; den Effekt mit der eigenen Last messen.
3. Nach dem Start einen Collector-Lauf abwarten (bis zu zehn Sekunden). Die Tabelle zeigt den Bean-Namen, die Anbindung, Statistikstatus, Query-/Entity-/Cache-Zähler, Transaktionen und maximale Query-Laufzeit. Zähler beziehen sich auf die jeweilige Factory seit deren Statistikstart, nicht auf den ausgewählten globalen Chartzeitraum. Ein ausgeschalteter Status bedeutet, dass die Factory erkannt wurde, die Statistik aber deaktiviert ist.

Klassische Spring-Konfiguration, im vorhandenen Bean `org.springframework.orm.hibernate5.LocalSessionFactoryBean`:

```xml
<property name="hibernateProperties">
  <props>
    <!-- vorhandene Hibernate-Einstellungen beibehalten -->
    <prop key="hibernate.generate_statistics">true</prop>
  </props>
</property>
```

Bei Spring JPA (`LocalContainerEntityManagerFactoryBean` oder `LocalEntityManagerFactoryBean`) heißt die Property `jpaProperties`; darin denselben Hibernate-Schlüssel setzen. Bei Spring Boot:

```properties
spring.jpa.properties.hibernate.generate_statistics=true
```

Jerry untersucht ausschließlich bereits initialisierte Singletons in Spring-Root- und DispatcherServlet-WebApplicationContexts. Es unterstützt direkte Hibernate-SessionFactories, Spring-Hibernate-FactoryBeans (hibernate4/hibernate5) und Spring-JPA-FactoryBeans/Proxys über deren native EntityManagerFactory, sofern diese eine Hibernate-SessionFactory ist. Ein gemeinsames natives Factory-Objekt wird pro Scan nur einmal gezählt. Andere JPA-Provider sowie ausschließlich außerhalb dieser Spring-Kontexte verwaltete Factories werden hier nicht automatisch erkannt. Lazy Beans werden nicht initialisiert. Ein JMX-Export ist für diese Hibernate-Tabelle nicht erforderlich.

Mit echtem Spring 5.3.39 und Hibernate 5.6.15.Final unter Java 8 geprüft. Andere unterstützte API-Varianten benötigen eine Prüfung mit der konkreten Anwendung. Grundlagen: [Hibernate-Statistiken](https://docs.hibernate.org/orm/5.6/userguide/html_single/#configurations-statistics) und [Spring EntityManagerFactoryInfo](https://docs.spring.io/spring-framework/docs/5.3.39/javadoc-api/org/springframework/orm/jpa/EntityManagerFactoryInfo.html).

## JMX-Beans einer Anwendung

Unter **Anwendungen → Anwendung → JMX** sehen Administratoren lokal registrierte Beans. Die Anwendung muss sie beim **Platform-MBeanServer dieser JVM** registrieren, zum Beispiel mit Spring MBeanExporter. Beans in einem separat erzeugten MBeanServer oder einer anderen JVM werden nicht gelesen. Die Liste und Attributwerte werden beim Öffnen, Auswählen oder bewussten Aktualisieren angefordert, unabhängig von der Monitoring-Betriebsart. Es gibt kein Hintergrundpolling.

Automatische Zuordnung:

- Der MBean-Classloader ist genau der Webapp-Classloader, oder
- die ObjectName-Eigenschaften `host` und `context` (alternativ `path`) passen zu Tomcat-Host und Context.

JMX besitzt keine allgemeine Webapp-Zuordnung. ModelMBeans mit gemeinsamem Classloader benötigen gegebenenfalls eine explizite Regel. Dafür im `web.xml` der **überwachten Anwendung** ergänzen und diese Anwendung neu starten:

```xml
<context-param>
  <param-name>jerry.jmx.patterns</param-name>
  <param-value>eure.domain:application=eure-app,*</param-value>
</context-param>
```

Alternativ die im JMX-Reiter angezeigte anwendungsspezifische Zeile in `conf/jerry.properties` eintragen und **Jerry** neu starten:

```properties
monitor.jmx.ANWENDUNGS_ID.patterns=eure.domain:application=eure-app,*
```

`ANWENDUNGS_ID` durch die im Reiter angezeigte ID ersetzen. Es gelten JMX-ObjectName-Muster; bis zu 16 Regeln, getrennt mit `|`. Die Domain und Eigenschaftswerte müssen zu den tatsächlich exportierten Beans passen. Keine pauschale `*:*`-Regel verwenden, wenn nur die Beans einer Anwendung angezeigt werden sollen. Die Auswahl prüft die Zuordnung erneut; eine fremde Bean kann nicht allein über ihre ID gelesen werden. Grundlage: [Java-8-MBeanServer](https://docs.oracle.com/javase/8/docs/api/javax/management/MBeanServer.html).

Die Liste liest Metadaten, die Detailansicht höchstens 64 einfache Attribute (primitive Typen, numerische Wrapper, Boolean, Character, String, BigDecimal/BigInteger). Texte werden auf 4096 Zeichen gekürzt. Komplexe Werte werden ausgelassen. Attributnamen mit Password, Passwd, Secret, Token, Credential, PrivateKey, ApiKey, AccessKey, ConnectionString oder URL werden vor dem Getter-Aufruf gesperrt; Trennzeichen wie `_` oder `-` werden bei dieser Prüfung ignoriert. Diese Namensprüfung ist keine vollständige Erkennung vertraulicher Inhalte; deshalb ist der Reiter auf Administratoren beschränkt. Jerry bietet keine JMX-Schreibzugriffe oder Operationsaufrufe.

Zwei Daemon-Lesearbeiter, acht wartende Aufträge, maximal 200 zugeordnete Beans und maximal 10.000 untersuchte Registrierungen pro Abruf; Zeitbudget zwischen Zugriffen eine Sekunde, HTTP-Wartezeit maximal 1,5 Sekunden. Ein fremder blockierender Getter kann nicht sicher erzwungen beendet werden und belegt bis zur Rückkehr einen Worker. Weitere Leser werden durch Warteschlangen- und Zeitgrenzen beschränkt.

## Connector-Transfervolumen

**Connectoren** zeigt Upload/Download pro Sekunde und kumulative Byte-Zähler je Connector. Eine Zeile auswählen, um Request-Durchsatz, Volumen und getrennte Up-/Download-Kurven zu sehen. Upload bedeutet Client → Tomcat, Download Tomcat → Client.

Zeitraumvolumen, Durchschnitt und Kurvenraten werden aus Differenzen kumulativer Zähler zwischen verfügbaren Messpunkten gebildet. Damit gehen übertragene Bytes bei ausgedünnter Historie nicht durch bloße Auswahl einzelner Momentanraten verloren. Raten beziehen sich auf das Intervall zwischen den verfügbaren Punkten; „Spitze“ ist deren Maximum und kann kurze Spitzen glätten. Es wird nur der tatsächlich vorhandene Verlauf ausgewertet, ohne Hochrechnung bis zu den Rändern des gewählten Zeitraums.

Erkannte Zählerrücksetzungen, verschwundene Connectoren und neue Collector-/JVM-Epochen trennen die Intervalle. Darüber wird kein Volumen erfunden. Ohne zwei gültige Punkte bleibt das Zeitraumvolumen nicht verfügbar. Ein Reset vollständig zwischen zwei Erfassungen ist nicht in jedem Fall erkennbar. Gezählt werden die von Tomcat gemeldeten Bytes, kein Ethernet-/TCP-/TLS-Overhead und keine nutzerspezifischen Dateitransfers.

## Schema im SQL-Arbeitsplatz

Beim ersten Öffnen einer Verbindung lädt Jerry das aktuell von `Connection.getSchema()` gemeldete Schema und dessen Tabellen automatisch. Bei MySQL/MariaDB wird der aktuelle JDBC-Katalog verwendet. Liefert ein älterer Treiber kein Schema, wird nur ein eindeutig zum Datenbankbenutzer passender Eintrag der Schemaliste vorgewählt und ausdrücklich als Fallback gekennzeichnet. Andernfalls bleibt die Auswahl offen; Jerry nimmt nicht wahllos das erste Schema.

Ein Pool bestimmt Anmeldedaten und gegebenenfalls eine Initialisierung der Verbindung; Datenbankbenutzer und aktuelles Schema müssen deshalb nicht denselben Namen haben. Das tatsächlich gemeldete Verbindungsschema hat Vorrang vor dem Benutzernamen. Bei mehreren Schemas bleibt eine andere Auswahl möglich.

Die Schemaauswahl im Browser filtert Metadaten und ändert keine SQL-Sitzung. **Als aktuelles Schema setzen** ändert das Schema (bzw. den MySQL-Katalog) ausdrücklich und erfordert vorher Commit oder Rollback. Autocommit bleibt standardmäßig aus. Ein manuell gewählter Browserfilter bleibt beim Aktualisieren bestehen; nach Wiederherstellung einer SQL-Sitzung wird ihr aktuelles Verbindungsschema erneut ermittelt.
