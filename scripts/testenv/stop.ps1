$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$testRoot = Join-Path $projectRoot '.tools/jerry-testenv'
if (!(Test-Path "$testRoot/process.json")) { Write-Output 'Keine gestartete Testinstanz registriert.'; exit 0 }
$settings = Get-Content "$testRoot/environment.json" -Raw | ConvertFrom-Json
$record = Get-Content "$testRoot/process.json" -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
if ($process) {
  if (!$process.CommandLine.Contains("-Dcatalina.base=$($settings.base)")) { throw 'PID gehört nicht mehr zur Jerry-Testumgebung; wird nicht beendet.' }
  if ($settings.shutdownPort) {
    & "$($settings.javaHome)/bin/java.exe" "-Dcatalina.home=$($settings.tomcatHome)" "-Dcatalina.base=$($settings.base)" -classpath "$($settings.tomcatHome)/bin/bootstrap.jar;$($settings.tomcatHome)/bin/tomcat-juli.jar" org.apache.catalina.startup.Bootstrap stop
    if ($LASTEXITCODE) { throw 'Tomcat-Shutdown fehlgeschlagen; siehe Konsole.' }
    Wait-Process -Id $record.pid -Timeout 30 -ErrorAction SilentlyContinue
    if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { throw 'Tomcat benötigt länger zum Stoppen. Prozess wurde nicht erzwungen beendet.' }
  } else {
    # Compatibility with the initial local instance created before a shutdown port existed.
    Stop-Process -Id $record.pid
    Wait-Process -Id $record.pid -Timeout 20 -ErrorAction SilentlyContinue
  }
}
Remove-Item -LiteralPath "$testRoot/process.json" -Force
Write-Output 'Jerry-Testinstanz gestoppt.'
