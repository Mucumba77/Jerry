$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$java8 = (Get-ChildItem "$root/.tools/java8" -Directory | Select-Object -First 1).FullName
$java17 = (Get-ChildItem "$root/.tools/platforms/java17" -Directory | Select-Object -First 1).FullName
$classes = Join-Path $root '.tools/platforms/modern-classes'
$deps = Join-Path $root '.tools/platforms/modern-deps'
New-Item -ItemType Directory -Force $classes, $deps | Out-Null
$env:JAVA_HOME = $java8
& "$root/.tools/apache-maven-3.9.9/bin/mvn.cmd" -B -ntp -f "$PSScriptRoot/modern-deps-pom.xml" org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies "-DoutputDirectory=$deps" | Out-Null
if ($LASTEXITCODE) { throw 'Modern fixture dependencies could not be retrieved.' }
$servlet = "$root/.tools/apache-tomcat-8.5.100/lib/servlet-api.jar"
$fixtureLibraries = if(Test-Path "$root/.tools/jerry-testenv/framework-2.1.0/WEB-INF/lib/javax.jms-api-2.0.1.jar") { "$root/.tools/jerry-testenv/framework-2.1.0/WEB-INF/lib" } else { "$root/.tools/jerry-testenv/framework/WEB-INF/lib" }
$jms = "$fixtureLibraries/javax.jms-api-2.0.1.jar"
$oldDeps = "$fixtureLibraries/*"
$sdk = "$root/dist/jerry-instrumentation-2.1.0-javax.jar"
& "$java8/bin/javac.exe" -encoding UTF-8 -source 8 -target 8 -cp "$servlet;$jms;$oldDeps;$sdk" -d $classes "$PSScriptRoot/ModernAdapterCompatibility.java"
if ($LASTEXITCODE) { throw 'Modern fixture compilation failed.' }
$source = "$root/.tools/platforms/modern-fixture-javax.jar"
$target = "$root/.tools/platforms/modern-fixture-jakarta.jar"
& "$java8/bin/jar.exe" cf $source -C $classes .
if ($LASTEXITCODE) { throw 'Modern fixture packaging failed.' }
& "$java8/bin/java.exe" -jar "$root/.tools/jakartaee-migration-shaded.jar" '-profile=EE' $source $target | Out-Null
if ($LASTEXITCODE) { throw 'Modern fixture migration failed.' }
$runtime = "$target;$root/dist/jerry-instrumentation-2.1.0-jakarta.jar;$deps/*"
& "$java17/bin/java.exe" -cp $runtime de.mucumba.jerry.testenv.ModernAdapterCompatibility
if ($LASTEXITCODE) { throw 'Modern adapter compatibility checks failed.' }
