$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$distribution = Join-Path $projectRoot 'dist'
$working = Join-Path $projectRoot '.tools'
New-Item -ItemType Directory -Force $working, $distribution | Out-Null
$mavenCommand = Get-Command mvn.cmd -ErrorAction SilentlyContinue
$maven = if ($mavenCommand) { $mavenCommand.Source } else { Join-Path $projectRoot '.tools/apache-maven-3.9.9/bin/mvn.cmd' }
& $maven -N -B -ntp org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy '-Dartifact=org.apache.tomcat:jakartaee-migration:1.0.13:jar:shaded' "-DoutputDirectory=$working" '-Dmdep.stripVersion=true'
if ($LASTEXITCODE) { throw 'Unable to download the Apache Jakarta EE migration tool.' }
$migrationTool = Join-Path $working 'jakartaee-migration-shaded.jar'
if (!(Test-Path -LiteralPath $migrationTool)) { throw "Migration tool not found: $migrationTool" }
$java = Join-Path $env:JAVA_HOME 'bin/java.exe'
$baseWar = Join-Path $projectRoot 'jerry-web/target/jerry.war'
$jakartaWar = Join-Path $working 'jerry-jakarta.war'
& $java -jar $migrationTool '-profile=TOMCAT' $baseWar $jakartaWar
if ($LASTEXITCODE) { throw 'Jakarta WAR migration failed.' }
$sdk = Join-Path $projectRoot 'jerry-instrumentation/target/jerry-instrumentation-2.0.0.jar'
& $java -jar $migrationTool '-profile=EE' $sdk (Join-Path $distribution 'jerry-instrumentation-2.0.0-jakarta.jar')
if ($LASTEXITCODE) { throw 'Jakarta instrumentation migration failed.' }
& $java -jar $migrationTool '-profile=TOMCAT' $sdk (Join-Path $distribution 'jerry-instrumentation-2.0.0-jakarta-servlet-javax-jms.jar')
if ($LASTEXITCODE) { throw 'Legacy JMS instrumentation migration failed.' }
$instrumentationStage = Join-Path $working 'jakarta-instrumentation/instrumentation'
New-Item -ItemType Directory -Force $instrumentationStage | Out-Null
Copy-Item -LiteralPath (Join-Path $distribution 'jerry-instrumentation-2.0.0-jakarta.jar') -Destination (Join-Path $instrumentationStage 'jerry-instrumentation-2.0.0.jar') -Force
Copy-Item -LiteralPath (Join-Path $distribution 'jerry-instrumentation-2.0.0-jakarta-servlet-javax-jms.jar') -Destination (Join-Path $instrumentationStage 'jerry-instrumentation-2.0.0-legacy-jms.jar') -Force
& (Join-Path $env:JAVA_HOME 'bin/jar.exe') uf $jakartaWar -C (Split-Path $instrumentationStage -Parent) instrumentation
if ($LASTEXITCODE) { throw 'Could not include Jakarta instrumentation artifacts in the WAR.' }
Copy-Item -LiteralPath $sdk -Destination (Join-Path $distribution 'jerry-instrumentation-2.0.0-javax.jar') -Force
foreach ($target in @(@('8.5','tomcat85',$baseWar), @('9.0','tomcat9',$baseWar), @('10.0','tomcat100',$jakartaWar), @('10.1','tomcat101',$jakartaWar), @('11.0','tomcat11',$jakartaWar))) {
  $name = "jerry-2.0.0-$($target[1]).war"
  $war = Join-Path $distribution $name
  Copy-Item -LiteralPath $target[2] -Destination $war -Force
  $manifest = Join-Path $working 'jerry-target-manifest.mf'
  [IO.File]::WriteAllText($manifest, "Jerry-Target-Tomcat: $($target[0])`r`n`r`n", [Text.Encoding]::ASCII)
  & (Join-Path $env:JAVA_HOME 'bin/jar.exe') umf $manifest $war
  if ($LASTEXITCODE) { throw "Unable to add target metadata to $name" }
  ((Get-FileHash -LiteralPath $war -Algorithm SHA256).Hash.ToLowerInvariant() + "  $name") | Set-Content -LiteralPath "$war.sha256" -Encoding ascii
  Write-Host "Built $name"
}
