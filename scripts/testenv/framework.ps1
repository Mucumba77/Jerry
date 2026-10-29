$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$settings = Get-Content "$projectRoot/.tools/jerry-testenv/environment.json" -Raw | ConvertFrom-Json
$target = Join-Path $projectRoot '.tools/jerry-testenv/framework-2.0.0'
New-Item -ItemType Directory -Force "$target/WEB-INF/lib", "$target/WEB-INF/classes" | Out-Null
$env:JAVA_HOME = $settings.javaHome
& "$projectRoot/.tools/apache-maven-3.9.9/bin/mvn.cmd" -B -ntp -f "$PSScriptRoot/framework-pom.xml" org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies "-DoutputDirectory=$target/WEB-INF/lib"
if ($LASTEXITCODE) { throw 'Framework fixture dependencies failed' }
Copy-Item "$projectRoot/jerry-instrumentation/target/jerry-instrumentation-2.0.0.jar" "$target/WEB-INF/lib/jerry-instrumentation-2.0.0.jar" -Force
$fixtureClasspath = "$($settings.tomcatHome)/lib/servlet-api.jar;$target/WEB-INF/lib/*"
& "$($settings.javaHome)/bin/javac.exe" -encoding UTF-8 -source 1.8 -target 1.8 -cp $fixtureClasspath -d "$target/WEB-INF/classes" "$PSScriptRoot/FrameworkFixture.java"
if ($LASTEXITCODE) { throw 'Framework fixture compilation failed' }
New-Item -ItemType Directory -Force "$target/WEB-INF/classes/META-INF" | Out-Null
[IO.File]::WriteAllText("$target/WEB-INF/classes/META-INF/persistence.xml", @'
<persistence xmlns="http://xmlns.jcp.org/xml/ns/persistence" version="2.2">
  <persistence-unit name="JerryJpa" transaction-type="RESOURCE_LOCAL">
    <provider>org.hibernate.jpa.HibernatePersistenceProvider</provider>
    <exclude-unlisted-classes>true</exclude-unlisted-classes>
  </persistence-unit>
</persistence>
'@, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$target/WEB-INF/web.xml", @'
<web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1">
  <context-param><param-name>jerry.jmx.patterns</param-name><param-value>de.mucumba.jerry.fixture.shared:application=framework,*</param-value></context-param>
  <display-name>Jerry Spring &amp; Quartz Test</display-name>
  <listener><listener-class>de.mucumba.jerry.testenv.FrameworkFixture</listener-class></listener>
  <servlet><servlet-name>framework</servlet-name><servlet-class>de.mucumba.jerry.testenv.FrameworkFixture</servlet-class></servlet>
  <servlet-mapping><servlet-name>framework</servlet-name><url-pattern>/api</url-pattern></servlet-mapping>
</web-app>
'@, [Text.UTF8Encoding]::new($false))
Push-Location $target
try { & "$($settings.javaHome)/bin/jar.exe" cf "$($settings.base)/webapps/jerry-framework.war" .; if ($LASTEXITCODE) { throw 'Fixture WAR failed' } } finally { Pop-Location }
