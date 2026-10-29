param([switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $env:JAVA_HOME) {
  $localJdk = Get-ChildItem "$PSScriptRoot\.tools\java8" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($localJdk) { $env:JAVA_HOME = $localJdk.FullName }
}
if (-not $env:JAVA_HOME) { throw 'Set JAVA_HOME to a JDK 8 installation.' }
$env:PATH = "$env:JAVA_HOME\bin;$env:PATH"
$mavenCommand = Get-Command mvn.cmd -ErrorAction SilentlyContinue
$maven = if ($mavenCommand) { $mavenCommand.Source } else { "$PSScriptRoot\.tools\apache-maven-3.9.9\bin\mvn.cmd" }
if (-not (Test-Path -LiteralPath $maven)) { throw 'Install Maven 3.9.x or unpack it in .tools/apache-maven-3.9.9.' }
Push-Location frontend
try { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' }; & npm.cmd run build; if ($LASTEXITCODE) { throw 'UI build failed' } } finally { Pop-Location }
$mavenArgs = @('-B','-ntp','clean','verify')
if ($SkipChecks) { $mavenArgs += '-DskipTests' }
$env:PATH = "$(Split-Path $maven -Parent);$env:PATH"
if (Get-Command rtk.exe -ErrorAction SilentlyContinue) { & rtk.exe mvn @mavenArgs } else { & $maven @mavenArgs }
if ($LASTEXITCODE) { throw 'Java build failed' }
& "$PSScriptRoot/scripts/platform-wars.ps1"
& "$PSScriptRoot/scripts/package.ps1"
Write-Host 'Jerry is ready: dist/jerry.war'
