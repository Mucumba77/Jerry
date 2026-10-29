$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$platforms = Join-Path $root '.tools/platforms'
$java8 = (Get-ChildItem "$root/.tools/java8" -Directory | Select-Object -First 1).FullName
$java11 = (Get-ChildItem "$platforms/java11" -Directory | Select-Object -First 1).FullName
$java17 = (Get-ChildItem "$platforms/java17" -Directory | Select-Object -First 1).FullName
$fixture = Join-Path $platforms 'fixture-src'
New-Item -ItemType Directory -Force "$fixture/WEB-INF/classes", "$fixture/WEB-INF/lib", "$fixture/META-INF" | Out-Null
$servlet = Join-Path $root '.tools/apache-tomcat-8.5.100/lib/servlet-api.jar'
$sdk = Join-Path $root 'dist/jerry-instrumentation-2.0.0-javax.jar'
& "$java8/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -cp "$servlet;$sdk" -d "$fixture/WEB-INF/classes" "$PSScriptRoot/PlatformFixture.java"
if ($LASTEXITCODE) { throw 'Fixture compilation failed' }
Copy-Item -LiteralPath $sdk -Destination "$fixture/WEB-INF/lib/jerry-instrumentation.jar" -Force
[IO.File]::WriteAllText("$fixture/WEB-INF/web.xml", '<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1"><servlet><servlet-name>fixture</servlet-name><servlet-class>de.mucumba.jerry.testenv.PlatformFixture</servlet-class></servlet><servlet-mapping><servlet-name>fixture</servlet-name><url-pattern>/api</url-pattern></servlet-mapping></web-app>', [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$fixture/META-INF/context.xml", '<Context><ResourceLink name="jdbc/JerryDemo" global="jdbc/JerryDemo" type="javax.sql.DataSource"/></Context>', [Text.UTF8Encoding]::new($false))
$fixtureWar=Join-Path $platforms 'fixture-javax.war'
Push-Location $fixture
try { & "$java8/bin/jar.exe" cf $fixtureWar .; if($LASTEXITCODE){throw 'Fixture packaging failed'} } finally { Pop-Location }
$fixtureJakarta=Join-Path $platforms 'fixture-jakarta.war'
& "$java8/bin/java.exe" -jar "$root/.tools/jakartaee-migration-shaded.jar" '-profile=TOMCAT' $fixtureWar $fixtureJakarta | Out-Null
if($LASTEXITCODE){throw 'Fixture migration failed'}
$targets=@(
  @{version='8.5.100'; family='tomcat85'; java=$java8; port=16864; shutdown=16874; fixture=$fixtureWar},
  @{version='9.0.123'; family='tomcat9'; java=$java8; port=16860; shutdown=16870; fixture=$fixtureWar},
  @{version='10.0.27'; family='tomcat100'; java=$java8; port=16861; shutdown=16871; fixture=$fixtureJakarta},
  @{version='10.1.61'; family='tomcat101'; java=$java11; port=16862; shutdown=16872; fixture=$fixtureJakarta},
  @{version='11.0.27'; family='tomcat11'; java=$java17; port=16863; shutdown=16873; fixture=$fixtureJakarta}
)
foreach($target in $targets) {
  if(Get-NetTCPConnection -State Listen -LocalPort $target.port -ErrorAction SilentlyContinue){throw "Test port $($target.port) is occupied"}
  if(Get-NetTCPConnection -State Listen -LocalPort $target.shutdown -ErrorAction SilentlyContinue){throw "Shutdown port $($target.shutdown) is occupied"}
  $tomcatHome=if($target.version -eq '8.5.100') { Join-Path $root '.tools/apache-tomcat-8.5.100' } else { Join-Path $platforms "tomcat-$($target.version)/apache-tomcat-$($target.version)" }
  $base=Join-Path $platforms "base-$($target.family)"
  New-Item -ItemType Directory -Force "$base/conf", "$base/lib", "$base/logs", "$base/temp", "$base/webapps", "$base/work", "$base/data" | Out-Null
  Copy-Item -LiteralPath "$tomcatHome/conf/web.xml", "$tomcatHome/conf/context.xml", "$tomcatHome/conf/catalina.properties", "$tomcatHome/conf/logging.properties" -Destination "$base/conf" -Force
  $fixtureLibraries = if(Test-Path "$root/.tools/jerry-testenv/framework-2.0.0/WEB-INF/lib/h2-2.2.224.jar") { "$root/.tools/jerry-testenv/framework-2.0.0/WEB-INF/lib" } else { "$root/.tools/jerry-testenv/framework/WEB-INF/lib" }
  Copy-Item -LiteralPath "$fixtureLibraries/h2-2.2.224.jar" -Destination "$base/lib" -Force
  Copy-Item -LiteralPath "$root/dist/jerry-2.0.0-$($target.family).war" -Destination "$base/webapps/jerry.war" -Force
  Copy-Item -LiteralPath $target.fixture -Destination "$base/webapps/fixture.war" -Force
  $password=[guid]::NewGuid().ToString('N'); $shutdownToken=[guid]::NewGuid().ToString('N')
  $users="<tomcat-users><role rolename=`"jerry-admin`"/><user username=`"platform-admin`" password=`"$password`" roles=`"jerry-admin`"/></tomcat-users>"
  [IO.File]::WriteAllText("$base/conf/tomcat-users.xml",$users,[Text.UTF8Encoding]::new($false))
  $server=@"
<Server address="127.0.0.1" port="$($target.shutdown)" shutdown="$shutdownToken">
 <Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"/>
 <GlobalNamingResources>
  <Resource name="UserDatabase" auth="Container" type="org.apache.catalina.UserDatabase" factory="org.apache.catalina.users.MemoryUserDatabaseFactory" pathname="conf/tomcat-users.xml"/>
  <Resource name="jdbc/JerryDemo" auth="Container" type="javax.sql.DataSource" factory="org.apache.tomcat.jdbc.pool.DataSourceFactory" driverClassName="org.h2.Driver" url="jdbc:h2:mem:jerry;DB_CLOSE_DELAY=-1" username="sa" password="" maxActive="12" initialSize="1" jmxEnabled="true"/>
 </GlobalNamingResources>
 <Service name="Catalina"><Connector address="127.0.0.1" port="$($target.port)" protocol="HTTP/1.1"/>
  <Engine name="Catalina" defaultHost="localhost"><Realm className="org.apache.catalina.realm.UserDatabaseRealm" resourceName="UserDatabase"/>
   <Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="true"/>
  </Engine></Service>
</Server>
"@
  [IO.File]::WriteAllText("$base/conf/server.xml",$server,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText("$base/conf/jerry.properties","monitor.interval.seconds=2`n",[Text.UTF8Encoding]::new($false))
  $arguments=@('-Xms64m','-Xmx384m',"-Dcatalina.home=$tomcatHome","-Dcatalina.base=$base","-Djava.io.tmpdir=$base/temp",'-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager',"-Djava.util.logging.config.file=$base/conf/logging.properties",'-classpath',"$tomcatHome/bin/bootstrap.jar;$tomcatHome/bin/tomcat-juli.jar",'org.apache.catalina.startup.Bootstrap','start')
  $quoted=$arguments | ForEach-Object {'"'+$_+'"'}
  $process=Start-Process -FilePath "$($target.java)/bin/java.exe" -ArgumentList $quoted -WorkingDirectory $base -WindowStyle Hidden -RedirectStandardOutput "$base/console.out.log" -RedirectStandardError "$base/console.err.log" -PassThru
  try {
    $ready=$false
    for($i=0;$i -lt 45;$i++){if($process.HasExited){throw "Tomcat $($target.version) exited. See $base/console.err.log"};try{$reply=Invoke-WebRequest "http://127.0.0.1:$($target.port)/jerry/login.html" -UseBasicParsing -TimeoutSec 2;if($reply.StatusCode -eq 200){$ready=$true;break}}catch{};Start-Sleep -Seconds 1}
    if(!$ready){throw "Tomcat $($target.version) did not start; see $base/console.err.log"}
    $env:JERRY_TEST_PORT=$target.port; $env:JERRY_TEST_VERSION=$target.version; $env:JERRY_TEST_PASSWORD=$password
    node "$PSScriptRoot/verify-platform.cjs"
    if($LASTEXITCODE){throw "Platform checks failed for Tomcat $($target.version); see $base/console.err.log"}
  } finally {
    $stopArguments=$arguments.Clone();$stopArguments[-1]='stop';$stopQuoted=$stopArguments | ForEach-Object {'"'+$_+'"'}
    & "$($target.java)/bin/java.exe" $stopArguments 2>$null
    if(!$process.WaitForExit(10000)) { $info=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue; if($info -and $info.CommandLine.Contains("-Dcatalina.base=$base")){Stop-Process -Id $process.Id -Force} }
    Remove-Item Env:JERRY_TEST_PASSWORD -ErrorAction SilentlyContinue
  }
}
