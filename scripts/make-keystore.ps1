# Creates the release signing key for the O Board Android app (once).
#   powershell -ExecutionPolicy Bypass -File scripts\make-keystore.ps1
# Produces android\oboard-release.jks and android\keystore.properties (both gitignored).
# KEEP BOTH SAFE: Android only installs updates signed with the same key. Back them up somewhere private.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$android = Join-Path $root "android"
$jks = Join-Path $android "oboard-release.jks"
$props = Join-Path $android "keystore.properties"
if (Test-Path $jks) { Write-Host "Keystore already exists: $jks"; exit 0 }

$keytool = @("$env:JAVA_HOME\bin\keytool.exe", "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $keytool) { throw "keytool not found. Install Android Studio or set JAVA_HOME." }

$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pass = [Convert]::ToBase64String($bytes).Replace("/", "x").Replace("+", "y").Replace("=", "")

& $keytool -genkeypair -v -keystore $jks -alias oboard -keyalg RSA -keysize 4096 -validity 10000 `
    -storepass $pass -keypass $pass -dname "CN=O Board, O=Personal, C=US" | Out-Null

Set-Content -Path $props -Encoding ascii -Value @"
storeFile=oboard-release.jks
storePassword=$pass
keyAlias=oboard
keyPassword=$pass
"@
Write-Host "Created $jks and $props. Back both up privately; they are needed to ship updates."
