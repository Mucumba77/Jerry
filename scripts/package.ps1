$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$releaseDirectory = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force $releaseDirectory | Out-Null
Copy-Item (Join-Path $projectRoot 'jerry-web/target/jerry.war') (Join-Path $releaseDirectory 'jerry.war')
Copy-Item (Join-Path $projectRoot 'jerry-instrumentation/target/jerry-instrumentation-2.1.0.jar') (Join-Path $releaseDirectory 'jerry-instrumentation.jar')
Copy-Item (Join-Path $projectRoot 'README.md'),(Join-Path $projectRoot 'NOTICE.md'),(Join-Path $projectRoot 'SECURITY.md'),(Join-Path $projectRoot 'CHANGELOG.md'),(Join-Path $projectRoot 'CONTRIBUTING.md') $releaseDirectory
if (Test-Path -LiteralPath (Join-Path $projectRoot 'LICENSE')) { Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $releaseDirectory -Force }
New-Item -ItemType Directory -Force (Join-Path $releaseDirectory 'docs') | Out-Null
Copy-Item (Join-Path $projectRoot 'docs/*') (Join-Path $releaseDirectory 'docs') -Recurse -Force
& node (Join-Path $PSScriptRoot 'notices.cjs')
if ($LASTEXITCODE) { throw 'Dependency inventory failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$licensePath = Join-Path $releaseDirectory 'THIRD-PARTY-LICENSES.txt'
Get-ChildItem (Join-Path $projectRoot 'jerry-web/target/jerry/WEB-INF/lib') -Filter '*.jar' | ForEach-Object {
  $jar = [IO.Compression.ZipFile]::OpenRead($_.FullName)
  $jarName = $_.Name
  try { foreach ($entry in $jar.Entries) { if ($entry.FullName -match '^META-INF/(LICENSE|NOTICE|COPYING)(\.|$)') {
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [IO.File]::AppendAllText($licensePath, "`n===== $jarName : $($entry.FullName) =====`n" + $reader.ReadToEnd(), [Text.Encoding]::UTF8) } finally { $reader.Dispose() }
  } } } finally { $jar.Dispose() }
}
function Get-SourceFiles([string]$Directory) {
  foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
    if ($item.Name -in @('target','node_modules','dist','.git','.tools','.reference','.idea','.vscode')) { continue }
    if ($item.PSIsContainer) { Get-SourceFiles $item.FullName } else { $item.FullName }
  }
}
$sourceArchive = Join-Path $releaseDirectory 'jerry-sources.zip'
$stream = [IO.File]::Open($sourceArchive, [IO.FileMode]::Create)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try { foreach ($file in Get-SourceFiles $projectRoot) {
  $relative = $file.Substring($projectRoot.Length + 1).Replace('\','/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
} } finally { $zip.Dispose(); $stream.Dispose() }
(Get-FileHash (Join-Path $releaseDirectory 'jerry.war') -Algorithm SHA256).Hash.ToLowerInvariant() + '  jerry.war' | Set-Content (Join-Path $releaseDirectory 'jerry.war.sha256') -Encoding ascii
$releaseZip = Join-Path $projectRoot 'dist/jerry-2.1.0.zip'
$releaseFiles = Get-ChildItem -LiteralPath $releaseDirectory | Where-Object {
  $_.Name -in @('docs','README.md','NOTICE.md','SECURITY.md','CHANGELOG.md','CONTRIBUTING.md','LICENSE','dependencies.json','THIRD-PARTY-LICENSES.txt','jerry-sources.zip','jerry.war','jerry.war.sha256','jerry-instrumentation.jar') -or
  $_.Name -like 'jerry-2.1.0-tomcat*.war' -or $_.Name -like 'jerry-2.1.0-tomcat*.war.sha256' -or $_.Name -like 'jerry-instrumentation-2.1.0-*.jar'
} | ForEach-Object FullName
Compress-Archive -LiteralPath $releaseFiles -DestinationPath $releaseZip -Force
Get-ChildItem -LiteralPath $releaseDirectory -File | Select-Object Name,Length
