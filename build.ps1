<#
.SYNOPSIS
    Automated Morphe Google Photos Patching & Signing Pipeline (Windows PowerShell).
.DESCRIPTION
    Builds a standalone patched Google Photos APK using Morphe CLI, Morphe Patches (.mpp),
    and uber-apk-signer for 4-byte zip alignment and v1/v2/v3 cryptographic signing.
    Configured for Pixel XL unlimited original quality storage spoofing and MicroG/GmsCore authentication.
.PARAMETER InputApk
    Path to the input Google Photos monolithic (nodpi) APK.
    If not specified, scans the ./input directory for the latest APK.
.PARAMETER Clean
    Cleans previous output, temporary files, and logs before running.
.PARAMETER SkipDownload
    Skips checking/downloading newer versions of toolchain components if already cached.
.PARAMETER KeystorePath
    Optional path to a custom .jks or .keystore file.
.EXAMPLE
    .\build.ps1
.EXAMPLE
    .\build.ps1 -InputApk .\input\photos-nodpi.apk -Clean
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $false)]
    [string]$InputApk = "",

    [Parameter(Mandatory = $false)]
    [switch]$Clean,

    [Parameter(Mandatory = $false)]
    [switch]$SkipDownload,

    [Parameter(Mandatory = $false)]
    [string]$KeystorePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Script Root & Directory Setup ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $ScriptDir) { $ScriptDir = Get-Location }

$ConfigPath       = Join-Path $ScriptDir "config.json"
$OptionsPath      = Join-Path $ScriptDir "options.json"
$InputDir         = Join-Path $ScriptDir "input"
$OutputDir        = Join-Path $ScriptDir "output"
$ToolsDir         = Join-Path $ScriptDir "tools"
$LogsDir          = Join-Path $ScriptDir "logs"
$CacheDir         = Join-Path $ScriptDir ".cache"
$TempDir          = Join-Path $ScriptDir "temp"

# Ensure directories exist
@($InputDir, $OutputDir, $ToolsDir, $LogsDir, $CacheDir, $TempDir) | ForEach-Object {
    if (-not (Test-Path $_)) { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
}

# --- Logging & Transcript Setup ---
$Timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$TranscriptPath = Join-Path $LogsDir "build-transcript-$Timestamp.log"

function Log-Message {
    param(
        [string]$Message,
        [string]$Level = "INFO",
        [string]$Color = "Gray"
    )
    $timeStr = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $formatted = "[$timeStr] [$Level] $Message"
    Write-Host $formatted -ForegroundColor $Color
    Add-Content -Path $TranscriptPath -Value $formatted -Encoding UTF8
}

function Log-Info    { param([string]$Msg) Log-Message $Msg "INFO"    "Cyan" }
function Log-Success { param([string]$Msg) Log-Message $Msg "SUCCESS" "Green" }
function Log-Warn    { param([string]$Msg) Log-Message $Msg "WARN"    "Yellow" }
function Log-Error   { param([string]$Msg) Log-Message $Msg "ERROR"   "Red" }
function Log-Header  {
    param([string]$Title)
    $line = "=" * 70
    Write-Host "`n$line" -ForegroundColor "DarkCyan"
    Write-Host "  $Title" -ForegroundColor "White"
    Write-Host "$line`n" -ForegroundColor "DarkCyan"
    Add-Content -Path $TranscriptPath -Value "`n$line`n  $Title`n$line`n" -Encoding UTF8
}

Log-Header "Morphe Google Photos Patching Pipeline v1.0.0"
Log-Info "Logging transcript to: $TranscriptPath"

# --- Optional Cleaning ---
if ($Clean) {
    Log-Info "Performing clean-up of temporary files and previous output..."
    Get-ChildItem -Path $OutputDir -File -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force
    Get-ChildItem -Path $TempDir -Recurse -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Log-Success "Clean completed."
}

# --- Pre-Flight Check 1: Java Runtime & Architecture ---
Log-Header "Step 1: Pre-Flight Environment Verification"

$javaCmd = Get-Command java -ErrorAction SilentlyContinue
if (-not $javaCmd) {
    Log-Error "Java runtime executable ('java') was not found in system PATH."
    Log-Error "Please install Java 17+ (64-bit JDK/JRE) and ensure it is added to your PATH."
    exit 1
}

$origEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $javaVerOutput = & cmd.exe /c "java -version 2>&1"
    if ($javaVerOutput -is [array]) { $javaVerOutput = $javaVerOutput -join "`n" }
} finally {
    $ErrorActionPreference = $origEap
}

Log-Info "Java version output:`n$javaVerOutput"

# Check version number >= 17
$javaMajor = 0
if ($javaVerOutput -match 'version "(?<ver>\d+)(\.\d+)?') {
    $javaMajor = [int]$Matches['ver']
} elseif ($javaVerOutput -match 'openjdk version "(?<ver>\d+)') {
    $javaMajor = [int]$Matches['ver']
}

if ($javaMajor -lt 17) {
    Log-Error "Java 17 or higher is required (Detected: Java $javaMajor). Google Photos multi-dex patching requires modern JVM capabilities."
    exit 1
}

# Verify 64-bit JVM
$is64Bit = $javaVerOutput -match '64-Bit' -or $javaVerOutput -match 'x64'
if (-not $is64Bit) {
    Log-Warn "JVM might not be 64-bit. A 64-bit JVM is strongly recommended to allocate -Xmx4g heap memory."
} else {
    Log-Success "Verified 64-bit Java $javaMajor runtime environment."
}

# --- Load Configuration ---
if (-not (Test-Path $ConfigPath)) {
    Log-Error "Missing config.json at: $ConfigPath"
    exit 1
}
$Config = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
Log-Info "Target App: $($Config.targetApp.packageName) ($($Config.targetApp.appName))"
Log-Info "Device Spoof Target: $($Config.spoofConfig.manufacturer) $($Config.spoofConfig.model) ($($Config.spoofConfig.device))"

# --- Pre-Flight Check 2: Monolithic nodpi APK Validation ---
Log-Header "Step 2: APK Discovery & Monolithic nodpi Validation"

$TargetApkPath = ""
if ($InputApk -and (Test-Path $InputApk)) {
    $TargetApkPath = (Resolve-Path $InputApk).Path
} else {
    $candidateApks = @(Get-ChildItem -Path $InputDir -Filter "*.apk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($candidateApks.Count -gt 0) {
        $TargetApkPath = $candidateApks[0].FullName
    }
}

if (-not $TargetApkPath -or -not (Test-Path $TargetApkPath)) {
    Log-Error "No valid input APK found!"
    Log-Error "Please place a Google Photos monolithic nodpi APK in '$InputDir\' or pass -InputApk '<path-to-apk>'."
    Log-Info  "Download monolithic (nodpi) release from APKMirror: https://www.apkmirror.com/apk/google-inc/photos/"
    exit 1
}

Log-Info "Analyzing target APK: $TargetApkPath"
$apkFile = Get-Item $TargetApkPath
$apkSizeMB = [math]::Round($apkFile.Length / 1MB, 2)
Log-Info "APK File Size: $apkSizeMB MB"

# Check for APKM / XAPK / Split bundle indicators
if ($TargetApkPath.EndsWith(".apkm", [System.StringComparison]::OrdinalIgnoreCase) -or
    $TargetApkPath.EndsWith(".xapk", [System.StringComparison]::OrdinalIgnoreCase) -or
    $TargetApkPath.EndsWith(".apks", [System.StringComparison]::OrdinalIgnoreCase)) {
    Log-Error "CRITICAL INTEGRITY REJECTION: The file '$($apkFile.Name)' is a split APK bundle."
    Log-Error "Split bundles causes instant launch crashes (Missing base resources/splits)."
    Log-Error "Please supply a monolithic (nodpi) universal APK."
    exit 1
}

# Inspect ZIP structure for monolithic integrity
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipArchive = [System.IO.Compression.ZipFile]::OpenRead($TargetApkPath)
$hasManifest = $false
$hasDex = $false
$isSplitArchive = $false

foreach ($entry in $zipArchive.Entries) {
    if ($entry.FullName -eq "AndroidManifest.xml") { $hasManifest = $true }
    if ($entry.FullName -match '^classes\d*\.dex$') { $hasDex = $true }
    if ($entry.FullName -match 'split_config\.' -or $entry.FullName -eq "base.apk") {
        $isSplitArchive = $true
    }
}
$zipArchive.Dispose()

if ($isSplitArchive) {
    Log-Error "CRITICAL: The APK contains internal split configurations. This is a split bundle, not a monolithic APK."
    exit 1
}

if (-not $hasManifest -or -not $hasDex) {
    Log-Error "CRITICAL: The provided file is corrupt or not a valid Android APK (Missing AndroidManifest.xml or DEX bytecode)."
    exit 1
}

Log-Success "APK integrity verified: Monolithic nodpi package confirmed."

# --- Dynamic GitHub Toolchain Asset Resolver ---
Log-Header "Step 3: Dynamic Toolchain Resolution (Morphe CLI, Patches, Signer)"

function Resolve-GitHubAsset {
    param(
        [string]$Repo,
        [string]$AssetPattern,
        [string]$DestinationPath
    )

    if ($SkipDownload -and (Test-Path $DestinationPath)) {
        Log-Info "Skipping download for [$Repo] as asset exists: $(Split-Path $DestinationPath -Leaf)"
        return
    }

    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    $headers = @{ "User-Agent" = "Morphe-GPhotos-Pipeline-Builder" }
    if ($env:GITHUB_TOKEN) {
        $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN"
    }

    Log-Info "Fetching latest release metadata for '$Repo'..."
    try {
        $releaseJson = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get -TimeoutSec 30
    } catch {
        Log-Warn "GitHub API lookup failed for '$Repo': $($_.Exception.Message)"
        if (Test-Path $DestinationPath) {
            Log-Warn "Falling back to existing cached asset at: $DestinationPath"
            return
        }
        throw "Cannot resolve required tool from '$Repo' and no local cache exists."
    }

    $matchedAsset = $null
    foreach ($asset in $releaseJson.assets) {
        if ($asset.name -match $AssetPattern) {
            $matchedAsset = $asset
            break
        }
    }

    if (-not $matchedAsset) {
        if (Test-Path $DestinationPath) {
            Log-Warn "No matching asset found in latest release matching '$AssetPattern'. Using local cache."
            return
        }
        throw "Could not find asset matching regex '$AssetPattern' in release '$($releaseJson.tag_name)' of '$Repo'."
    }

    $downloadUrl = $matchedAsset.browser_download_url
    $assetName = $matchedAsset.name
    Log-Info "Found asset: $assetName (Version: $($releaseJson.tag_name), Size: $([math]::Round($matchedAsset.size / 1MB, 2)) MB)"

    # Download with progress
    Log-Info "Downloading $assetName..."
    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "Morphe-GPhotos-Pipeline-Builder")
    if ($env:GITHUB_TOKEN) { $webClient.Headers.Add("Authorization", "Bearer $env:GITHUB_TOKEN") }
    $webClient.DownloadFile($downloadUrl, $DestinationPath)
    $webClient.Dispose()

    Log-Success "Successfully downloaded and cached: $assetName"
}

$MorpheCliJar    = Join-Path $ToolsDir "morphe-cli.jar"
$MorphePatchesMpp = Join-Path $ToolsDir "patches.mpp"
$UberSignerJar   = Join-Path $ToolsDir "uber-apk-signer.jar"

Resolve-GitHubAsset -Repo $Config.toolchain.morpheCli.repo     -AssetPattern $Config.toolchain.morpheCli.assetRegex     -DestinationPath $MorpheCliJar
Resolve-GitHubAsset -Repo $Config.toolchain.morphePatches.repo -AssetPattern $Config.toolchain.morphePatches.assetRegex -DestinationPath $MorphePatchesMpp
Resolve-GitHubAsset -Repo $Config.toolchain.uberApkSigner.repo -AssetPattern $Config.toolchain.uberApkSigner.assetRegex -DestinationPath $UberSignerJar

# --- Patch Execution via Morphe CLI ---
Log-Header "Step 4: Executing Morphe Patching Pipeline (-Xmx4g Heap)"

$TempPatchedApk = Join-Path $TempDir "patched-unsigned.apk"
if (Test-Path $TempPatchedApk) { Remove-Item $TempPatchedApk -Force }

# JVM Flags to handle multi-dex memory requirements
$jvmMaxHeap = $Config.jvmOptions.maxHeap
$jvmInitHeap = $Config.jvmOptions.initialHeap
$jvmEncoding = $Config.jvmOptions.fileEncoding
$jvmGc = $Config.jvmOptions.garbageCollector

Log-Info "Allocating JVM Heap: $jvmMaxHeap, GC: $jvmGc"

$patchArgs = @(
    $jvmMaxHeap,
    $jvmInitHeap,
    $jvmEncoding,
    $jvmGc,
    "-jar", $MorpheCliJar,
    "patch",
    "-f",
    "--unsigned",
    "--patches", $MorphePatchesMpp,
    "--options-file", $OptionsPath,
    "-o", $TempPatchedApk,
    $TargetApkPath
)

Log-Info "Executing: java $($patchArgs -join ' ')"

$origEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & java @patchArgs
    $patchExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $origEap
}

if ($patchExitCode -ne 0 -or -not (Test-Path $TempPatchedApk)) {
    Log-Error "Morphe patching process failed with exit code: $patchExitCode"
    exit 1
}

Log-Success "Morphe patching completed successfully. Patched APK generated."

# --- APK Alignment & v1/v2/v3 Signing via uber-apk-signer ---
Log-Header "Step 5: Automated 4-Byte Alignment & v1/v2/v3 Signing (uber-apk-signer)"

$FinalSignedApk = Join-Path $OutputDir "com.google.android.apps.photos-morphe-signed.apk"
if (Test-Path $FinalSignedApk) { Remove-Item $FinalSignedApk -Force }

$signerArgs = @(
    "-jar", $UberSignerJar,
    "-a", $TempPatchedApk,
    "-o", $OutputDir,
    "--allowResign",
    "--verbose"
)

# Custom keystore support if provided
$effectiveKeystore = ""
if ($KeystorePath -and (Test-Path $KeystorePath)) {
    $effectiveKeystore = (Resolve-Path $KeystorePath).Path
} elseif ($env:KEYSTORE_PATH -and (Test-Path $env:KEYSTORE_PATH)) {
    $effectiveKeystore = (Resolve-Path $env:KEYSTORE_PATH).Path
}

if ($effectiveKeystore) {
    Log-Info "Using custom signing keystore: $effectiveKeystore"
    $ksAlias = if ($env:KEY_ALIAS) { $env:KEY_ALIAS } else { "release" }
    $ksPass  = if ($env:KEY_STORE_PASS) { $env:KEY_STORE_PASS } else { "" }
    $keyPass = if ($env:KEY_PASS) { $env:KEY_PASS } else { "" }
    $signerArgs += @(
        "--ks", $effectiveKeystore,
        "--ksAlias", $ksAlias,
        "--ksPass", $ksPass,
        "--keyPass", $keyPass
    )
} else {
    Log-Info "No custom keystore specified. uber-apk-signer will generate a resilient, auto-aligned debug key."
}

Log-Info "Running uber-apk-signer..."
$origEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & java @signerArgs
    $signerExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $origEap
}

# Locate output signed APK
$signedCandidates = @(Get-ChildItem -Path $OutputDir -Filter "*signed*.apk" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
if ($signedCandidates.Count -gt 0) {
    Move-Item -Path $signedCandidates[0].FullName -Destination $FinalSignedApk -Force
} else {
    # Fallback check
    if (Test-Path (Join-Path $OutputDir "patched-unsigned-aligned-signed.apk")) {
        Move-Item -Path (Join-Path $OutputDir "patched-unsigned-aligned-signed.apk") -Destination $FinalSignedApk -Force
    }
}

if (-not (Test-Path $FinalSignedApk)) {
    Log-Error "Failed to produce signed APK artifact in: $OutputDir"
    exit 1
}

# --- Signature & Hash Verification ---
Log-Header "Step 6: Integrity Verification & Summary"

$finalFile = Get-Item $FinalSignedApk
$finalSizeMB = [math]::Round($finalFile.Length / 1MB, 2)

$sha256 = (Get-FileHash -Path $FinalSignedApk -Algorithm SHA256).Hash.ToLower()
$md5    = (Get-FileHash -Path $FinalSignedApk -Algorithm MD5).Hash.ToLower()

Log-Success "BUILD SUCCEEDED!"
Log-Info "Final Artifact : $FinalSignedApk"
Log-Info "File Size      : $finalSizeMB MB"
Log-Info "SHA-256 Digest : $sha256"
Log-Info "MD5 Digest     : $md5"

Write-Host "`n----------------------------------------------------------------------" -ForegroundColor "Green"
Write-Host "  NEXT STEPS (DEPLOYMENT TO DEVICE)" -ForegroundColor "White"
Write-Host "----------------------------------------------------------------------" -ForegroundColor "Green"
Write-Host "1. Install GmsCore (MicroG) if not already installed:" -ForegroundColor "Cyan"
Write-Host "   https://github.com/ReVanced/GmsCore/releases" -ForegroundColor "DarkCyan"
Write-Host "2. Sideload the signed APK to your Android device via ADB:" -ForegroundColor "Cyan"
Write-Host "   adb install -r `"$FinalSignedApk`"" -ForegroundColor "Yellow"
Write-Host "3. Whitelist Google Photos & GmsCore in Battery Optimization (Unrestricted)." -ForegroundColor "Cyan"
Write-Host "4. Open Google Photos, sign in with your Google account, and check" -ForegroundColor "Cyan"
Write-Host "   Backup Settings -> 'This Pixel can back up unlimited photos & videos'." -ForegroundColor "Cyan"
Write-Host "----------------------------------------------------------------------`n" -ForegroundColor "Green"

Add-Content -Path $TranscriptPath -Value "Final Artifact: $FinalSignedApk`nSHA-256: $sha256`nMD5: $md5`nBUILD SUCCESS" -Encoding UTF8
exit 0
