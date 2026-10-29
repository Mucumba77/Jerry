$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$testRoot = Join-Path $projectRoot '.tools/jerry-testenv'
if (!(Test-Path "$testRoot/environment.json")) { throw 'Zuerst setup.ps1 ausführen.' }
$settings = Get-Content "$testRoot/environment.json" -Raw | ConvertFrom-Json
if (Test-Path "$testRoot/process.json") {
  $previous = Get-Content "$testRoot/process.json" -Raw | ConvertFrom-Json
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine.Contains("-Dcatalina.base=$($settings.base)")) { Write-Output "Läuft bereits: $($settings.url)"; exit 0 }
}
if (Get-NetTCPConnection -State Listen -LocalPort $settings.port -ErrorAction SilentlyContinue) { throw "Port $($settings.port) ist belegt." }
$arguments = @('-Xms128m','-Xmx512m','-Dfile.encoding=UTF-8',"-Dcatalina.home=$($settings.tomcatHome)","-Dcatalina.base=$($settings.base)","-Djava.io.tmpdir=$($settings.base)/temp",'-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager',"-Djava.util.logging.config.file=$($settings.base)/conf/logging.properties",'-classpath',"$($settings.tomcatHome)/bin/bootstrap.jar;$($settings.tomcatHome)/bin/tomcat-juli.jar",'org.apache.catalina.startup.Bootstrap','start')
$quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
$process = Start-Process -FilePath "$($settings.javaHome)/bin/java.exe" -ArgumentList $quotedArguments -WorkingDirectory $settings.base -WindowStyle Hidden -RedirectStandardOutput "$testRoot/console.out.log" -RedirectStandardError "$testRoot/console.err.log" -PassThru
@{ pid=$process.Id; started=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content "$testRoot/process.json" -Encoding utf8
$ready = $false
for ($attempt=0; $attempt -lt 60; $attempt++) {
  if ($process.HasExited) { throw "Tomcat wurde beendet. Siehe $testRoot/console.err.log" }
  try { $response = Invoke-WebRequest $settings.url -TimeoutSec 2 -UseBasicParsing; if ($response.StatusCode -eq 200) { $ready=$true; break } } catch { }
  Start-Sleep -Seconds 1
}
if (!$ready) { throw "Tomcat ist noch nicht erreichbar. Siehe $testRoot/console.err.log" }
Write-Output "Jerry läuft: $($settings.url)"
Write-Output "PID: $($process.Id) | Zugangsdaten: $testRoot/access.json"
