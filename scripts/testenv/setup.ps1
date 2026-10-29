param(
  [int]$Port = 16850,
  [int]$ShutdownPort = 16805,
  [string]$TomcatHome = '',
  [string]$JavaHome = '',
  [string]$H2Jar = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (!$TomcatHome) { $TomcatHome = Join-Path $projectRoot '.tools/apache-tomcat-8.5.100' }
if (!$JavaHome) { $JavaHome = Join-Path $projectRoot '.tools/java8/jdk8u504-b01' }
if (!$H2Jar) { $H2Jar = Join-Path $env:USERPROFILE '.m2/repository/com/h2database/h2/2.2.224/h2-2.2.224.jar' }
$testRoot = Join-Path $projectRoot '.tools/jerry-testenv'
$base = Join-Path $testRoot 'tomcat'
$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($required in @("$TomcatHome/lib/catalina.jar", "$JavaHome/bin/javac.exe", $H2Jar, "$projectRoot/dist/jerry.war")) {
  if (!(Test-Path -LiteralPath $required)) { throw "Voraussetzung fehlt: $required. Tomcat 8.5.100, JDK 8 und H2 2.2.224 angeben." }
}
if (Test-Path "$testRoot/process.json") {
  $previous = Get-Content "$testRoot/process.json" -Raw | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -like "*-Dcatalina.base=$base*") { throw 'Testumgebung vor dem Setup mit stop.ps1 stoppen.' }
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { throw "Port $Port ist belegt." }
if ($Port -lt 1024 -or $Port -gt 65535 -or $ShutdownPort -lt 1024 -or $ShutdownPort -gt 65535 -or $Port -eq $ShutdownPort) { throw 'Unterschiedliche Ports zwischen 1024 und 65535 angeben.' }
if (Get-NetTCPConnection -State Listen -LocalPort $ShutdownPort -ErrorAction SilentlyContinue) { throw "Shutdown-Port $ShutdownPort ist belegt." }
foreach ($directory in @('conf/Catalina/localhost','logs','temp','work','webapps','lib','data')) {
  New-Item -ItemType Directory -Force (Join-Path $base $directory) | Out-Null
}
Copy-Item "$TomcatHome/conf/*" "$base/conf" -Recurse -Force
Copy-Item $H2Jar "$base/lib/h2-2.2.224.jar" -Force
Copy-Item "$projectRoot/dist/jerry.war" "$base/webapps/jerry.war" -Force
$accessFile = Join-Path $testRoot 'access.json'
if (Test-Path $accessFile) { $access = Get-Content $accessFile -Raw | ConvertFrom-Json } else {
  $access = [pscustomobject]@{ user='jerry-test'; password=[Guid]::NewGuid().ToString('N'); viewer='jerry-viewer'; viewerPassword=[Guid]::NewGuid().ToString('N'); reader='jerry-reader'; readerPassword=[Guid]::NewGuid().ToString('N') }
}
$databasePassword = 'jerry-local-fixture-only'
$databaseUrl = 'jdbc:h2:file:' + ($base.Replace('\','/') + '/data/demo;DB_CLOSE_ON_EXIT=FALSE')
& "$JavaHome/bin/java.exe" '-Dfile.encoding=UTF-8' -cp "$base/lib/h2-2.2.224.jar" org.h2.tools.RunScript -url $databaseUrl -user sa -password $databasePassword -script "$PSScriptRoot/seed.sql"
if ($LASTEXITCODE) { throw 'Testdatenbank konnte nicht initialisiert werden.' }
$readerSql = "CREATE USER IF NOT EXISTS JERRY_READER PASSWORD 'jerry-reader-fixture'; GRANT SELECT ON TEST_CUSTOMERS TO JERRY_READER; GRANT SELECT ON TEST_TRANSACTIONS TO JERRY_READER;"
[IO.File]::WriteAllText("$testRoot/reader.sql", $readerSql, $utf8)
& "$JavaHome/bin/java.exe" -cp "$base/lib/h2-2.2.224.jar" org.h2.tools.RunScript -url $databaseUrl -user sa -password $databasePassword -script "$testRoot/reader.sql"
if ($LASTEXITCODE) { throw 'Lesender Datenbankbenutzer konnte nicht angelegt werden.' }
$shutdownToken = [Guid]::NewGuid().ToString('N')
$server = @"
<?xml version="1.0" encoding="UTF-8"?>
<Server address="127.0.0.1" port="$ShutdownPort" shutdown="$shutdownToken">
  <Listener className="org.apache.catalina.startup.VersionLoggerListener"/>
  <Listener className="org.apache.catalina.core.JreMemoryLeakPreventionListener"/>
  <Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"/>
  <Listener className="org.apache.catalina.core.ThreadLocalLeakPreventionListener"/>
  <GlobalNamingResources>
    <Resource name="UserDatabase" auth="Container" type="org.apache.catalina.UserDatabase" factory="org.apache.catalina.users.MemoryUserDatabaseFactory" pathname="conf/tomcat-users.xml"/>
    <Resource name="jdbc/JerryDemo" auth="Container" type="javax.sql.DataSource" factory="org.apache.tomcat.jdbc.pool.DataSourceFactory" driverClassName="org.h2.Driver" url="$databaseUrl" username="sa" password="$databasePassword" maxActive="12" initialSize="1" minIdle="1" maxIdle="4" testOnBorrow="true" validationQuery="SELECT 1" jmxEnabled="true"/>
  </GlobalNamingResources>
  <Service name="Catalina">
    <Executor name="jerryTestExecutor" namePrefix="jerry-test-" maxThreads="40" minSpareThreads="4"/>
    <Connector address="127.0.0.1" port="$Port" protocol="org.apache.coyote.http11.Http11NioProtocol" executor="jerryTestExecutor" connectionTimeout="20000" maxParameterCount="1000" URIEncoding="UTF-8"/>
    <Engine name="Catalina" defaultHost="localhost">
      <Realm className="org.apache.catalina.realm.LockOutRealm"><Realm className="org.apache.catalina.realm.UserDatabaseRealm" resourceName="UserDatabase"/></Realm>
      <Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="true">
        <Valve className="org.apache.catalina.valves.AccessLogValve" directory="logs" prefix="access" suffix=".log" pattern="%h %l %u %t &quot;%r&quot; %s %b %D"/>
      </Host>
    </Engine>
  </Service>
</Server>
"@
[IO.File]::WriteAllText("$base/conf/server.xml", $server, $utf8)
[IO.File]::WriteAllText("$base/conf/tomcat-users.xml", @"
<?xml version="1.0" encoding="UTF-8"?>
<tomcat-users>
  <role rolename="jerry-admin"/><role rolename="jerry-viewer"/><role rolename="jerry-sql-read"/>
  <user username="$($access.user)" password="$($access.password)" roles="jerry-admin"/>
  <user username="$($access.viewer)" password="$($access.viewerPassword)" roles="jerry-viewer"/>
  <user username="$($access.reader)" password="$($access.readerPassword)" roles="jerry-viewer,jerry-sql-read"/>
</tomcat-users>
"@, $utf8)
[IO.File]::WriteAllText("$base/conf/jerry.properties", @"
monitor.interval.seconds=2
datasource.demo-reader.driver=org.h2.Driver
datasource.demo-reader.url=$databaseUrl
datasource.demo-reader.user=JERRY_READER
datasource.demo-reader.password=jerry-reader-fixture
datasource.demo-reader.readOnlyEnforced=true
"@, $utf8)
$fixture = Join-Path $testRoot 'fixture'
New-Item -ItemType Directory -Force "$fixture/WEB-INF/classes" | Out-Null
& "$JavaHome/bin/javac.exe" -encoding UTF-8 -source 1.8 -target 1.8 -cp "$TomcatHome/lib/servlet-api.jar" -d "$fixture/WEB-INF/classes" "$PSScriptRoot/FixtureServlet.java"
if ($LASTEXITCODE) { throw 'Beispielanwendung konnte nicht kompiliert werden.' }
[IO.File]::WriteAllText("$fixture/WEB-INF/web.xml", @'
<?xml version="1.0" encoding="UTF-8"?>
<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1">
  <display-name>Jerry Testanwendung</display-name>
  <servlet><servlet-name>fixture</servlet-name><servlet-class>de.mucumba.jerry.testenv.FixtureServlet</servlet-class></servlet>
  <servlet-mapping><servlet-name>fixture</servlet-name><url-pattern>/api</url-pattern></servlet-mapping>
  <resource-ref><res-ref-name>jdbc/JerryDemo</res-ref-name><res-type>javax.sql.DataSource</res-type><res-auth>Container</res-auth></resource-ref>
</web-app>
'@, $utf8)
[IO.File]::WriteAllText("$fixture/index.jsp", @'
<%@ page contentType="text/html;charset=UTF-8" %>
<!doctype html><html lang="de"><meta charset="utf-8"><title>Jerry Testanwendung</title>
<h1>Jerry Testanwendung</h1><p>Tomcat 8.5.100 / Java 8 – Grüße aus Köln.</p>
<p>Session: <%= session.getId() %></p><a href="api">Datenbank und Session prüfen</a>
</html>
'@, $utf8)
[IO.File]::WriteAllText("$base/conf/Catalina/localhost/jerry-demo.xml", '<Context><ResourceLink name="jdbc/JerryDemo" global="jdbc/JerryDemo" type="javax.sql.DataSource"/></Context>', $utf8)
& "$JavaHome/bin/jar.exe" cf "$base/webapps/jerry-demo.war" -C $fixture .
if ($LASTEXITCODE) { throw 'Test-WAR konnte nicht erstellt werden.' }
$log = "2026-10-19T10:00:00.000 INFO [fixture] demo.Logger - Start: Grüße aus Köln`n2026-10-19T10:01:00.000 ERROR [fixture] demo.Logger - Archiv-Testfehler: Müller; Söhne`njava.lang.IllegalStateException: Beispielfehler`n`t at de.mucumba.jerry.testenv.FixtureServlet.doGet(FixtureServlet.java:1)`n"
[IO.File]::WriteAllText("$base/logs/demo.log.1", $log, $utf8)
[IO.File]::WriteAllText("$base/logs/demo.log", $log.Replace('2026-10-19','2026-10-20'), $utf8)
$output = [IO.File]::Create("$base/logs/demo.log.2.gz")
$gzip = [IO.Compression.GZipStream]::new($output, [IO.Compression.CompressionMode]::Compress)
try { $bytes = $utf8.GetBytes($log.Replace('2026-10-19','2026-10-18')); $gzip.Write($bytes,0,$bytes.Length) } finally { $gzip.Dispose(); $output.Dispose() }
$settings = [pscustomobject]@{ tomcatHome=[IO.Path]::GetFullPath($TomcatHome); javaHome=[IO.Path]::GetFullPath($JavaHome); base=$base; port=$Port; shutdownPort=$ShutdownPort; url="http://127.0.0.1:$Port/jerry/"; warSha256=(Get-FileHash "$base/webapps/jerry.war" -Algorithm SHA256).Hash }
[IO.File]::WriteAllText("$testRoot/environment.json", ($settings | ConvertTo-Json), $utf8)
[IO.File]::WriteAllText($accessFile, ($access | ConvertTo-Json), $utf8)
Write-Output "Testumgebung erstellt: $($settings.url)"
Write-Output "Zugangsdaten: $accessFile"
Write-Output 'Start: ./scripts/testenv/start.ps1'
