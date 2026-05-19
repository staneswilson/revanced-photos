# Setup & Run Guide — Google Photos ReVanced Pipeline

This guide covers everything needed to run the pipeline **locally** (Windows) or via **GitHub Actions** (CI/CD).

---

## Prerequisites

Make sure the following tools are installed and available in your `PATH`:

| Tool                    | Version | Install                                                    |
| ----------------------- | ------- | ---------------------------------------------------------- |
| Node.js                 | ≥ 20    | [nodejs.org](https://nodejs.org)                           |
| pnpm                    | ≥ 8     | `npm i -g pnpm`                                            |
| Java (JDK)              | ≥ 17    | [adoptium.net](https://adoptium.net)                       |
| Android SDK Build-Tools | 34.x    | via Android Studio SDK Manager                             |
| apkeep                  | 0.17.0  | See below                                                  |
| APKEditor               | 1.4.8   | See below — required when Photos ships as a split-APK XAPK |

### Install `apkeep` (Windows)

```powershell
$version = "0.17.0"
$sha256 = "05c2ea04b3211568285bd5e27a695b28292850cd3e414f6b412b1d31c1f4e1f7"
Invoke-WebRequest -Uri "https://github.com/EFForg/apkeep/releases/download/$version/apkeep-x86_64-pc-windows-msvc.exe" -OutFile "apkeep.exe"
# Verify hash
(Get-FileHash apkeep.exe -Algorithm SHA256).Hash.ToLower()   # must match $sha256
# Move to a folder in PATH, e.g.:
Move-Item apkeep.exe "C:\Windows\System32\apkeep.exe"
```

### Install APKEditor (Windows)

```powershell
$version = "1.4.8"
$sha256 = "026906af28497577496a3e1f5054a878a7cf9c1b3889626882d87ea88d09c20f"
Invoke-WebRequest -Uri "https://github.com/REAndroid/APKEditor/releases/download/V$version/APKEditor-$version.jar" -OutFile "APKEditor.jar"
# Verify hash
(Get-FileHash APKEditor.jar -Algorithm SHA256).Hash.ToLower()   # must match $sha256
# Move to a stable location and export the env var:
Move-Item APKEditor.jar "$env:USERPROFILE\APKEditor.jar"
[System.Environment]::SetEnvironmentVariable('APKEDITOR_JAR', "$env:USERPROFILE\APKEditor.jar", 'User')
```

The pipeline only invokes APKEditor when apkeep produces an XAPK (split-APK bundle), which is how Photos now ships on APKPure. If `APKEDITOR_JAR` is unset and an XAPK is encountered, the build fails with a clear error pointing here.

### Verify `apksigner` is on PATH

```powershell
# It lives inside Android SDK build-tools. Add it to PATH or run directly:
$env:Path += ";$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"
apksigner --version
```

> **apkeep CLI note.** The internal download-source value is `apk-pure` (lowercase, hyphenated). If you ever invoke `apkeep` by hand, use `-d apk-pure`, not `-d apkpure` — the latter is rejected by 0.17.0+ as `invalid value`.

---

## Step 1 — Generate a Signing Keystore

> Skip this step if you already have a `.jks` keystore.

```powershell
keytool -genkeypair `
  -keystore revanced-key.jks `
  -alias revanced `
  -keyalg RSA `
  -keysize 2048 `
  -validity 10000 `
  -storepass changeme `
  -keypass changeme `
  -dname "CN=ReVanced, OU=Build, O=Personal, L=City, ST=State, C=US"
```

This creates `revanced-key.jks` in the current directory.

---

## Step 2 — Convert Keystore to Base64

```powershell
# Windows PowerShell
$bytes = [System.IO.File]::ReadAllBytes("revanced-key.jks")
[System.Convert]::ToBase64String($bytes) | Out-File -NoNewline keystore.b64
```

Copy the contents of `keystore.b64` — you'll paste it into your `.env` and GitHub Secrets.

> ⚠️ Keep `revanced-key.jks` and `keystore.b64` safe. Never commit them to git.

---

## Step 3 — Create Your `.env` File

Copy the template and fill in your values:

```powershell
Copy-Item .env.example .env
```

Then open `.env` and fill in the values:

```env
GITHUB_TOKEN=ghp_your_personal_access_token_here

KEYSTORE_BASE64=<paste the full base64 string from keystore.b64>
KEY_ALIAS=revanced
KEY_STORE_PASS=changeme
KEY_PASS=changeme

# Optional
# GPHOTOS_VERSION=7.76.0
# SKIP_MAGISK=true
# SKIP_ICON_RECOLOR=true
# APK_SOURCE=apkmirror   # default; set to 'apkpure' to force the legacy path

# Required only if Photos ships as an XAPK (the pipeline auto-detects). Absolute path to APKEditor.jar.
# APKEDITOR_JAR=C:\Users\you\APKEditor.jar
```

> **About `GPHOTOS_VERSION`.** This is _optional_. When unset (and `config/versions.json` has an empty `gphotos.version`), the orchestrator runs `apkeep -l` first to read APKPure's current latest 4-segment version of `com.google.android.apps.photos` and uses it for the build. Pin a value here only if you want to lock to a specific Photos build — and use the full 4-segment APKPure version (e.g. `7.75.0.911466973`), not the 3-segment marketing version (`7.75.0`), which APKPure does not recognize as an exact match.

> **About `SKIP_ICON_RECOLOR`.** By default the pipeline grayscales the launcher icon resources (`res/mipmap-*/ic_launcher*.{png,webp}` and `res/drawable-*/ic_launcher_foreground*`) so the patched app is visually distinct from stock Photos on the home screen. Set `SKIP_ICON_RECOLOR=true` to keep the stock colored icon. Per-icon failures during recolor are non-fatal (logged + counted) — the recolor step is purely cosmetic and never aborts the build.

### Generate a GitHub Personal Access Token (PAT)

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scope: `public_repo` (or `repo` for private repos)
4. Copy the token and paste it as `GITHUB_TOKEN`

---

## Step 4 — Build and Run Locally

```powershell
# Install dependencies
pnpm install

# Build + run in one command (reads .env automatically)
pnpm run dev:run
```

This will:

1. Compile TypeScript to `dist/`
2. Fetch the latest ReVanced CLI / Patches / Integrations from GitHub
3. Verify all SHA-256 checksums
4. Download Google Photos APK via `apkeep`
5. Patch with `spoof-features` (spoofs Pixel XL device)
6. Sign the APK with your keystore
7. Build a Magisk flashable `.zip` module
8. Write `workspace/meta.json` and `workspace/release-notes.md`

Outputs will be in the `workspace/` directory:

- `workspace/output-signed.apk` — Install on non-root devices (with MicroG)
- `workspace/magisk-revanced-gphotos.zip` — Flash in Magisk/KernelSU for root

---

## Step 5 — Configure GitHub Actions (CI/CD)

For automated weekly builds, add these to your repository:  
**Settings → Secrets and variables → Actions → New repository secret**

| Secret Name       | Value                      |
| ----------------- | -------------------------- |
| `KEYSTORE_BASE64` | Contents of `keystore.b64` |
| `KEY_ALIAS`       | `revanced` (or your alias) |
| `KEY_STORE_PASS`  | Your keystore password     |
| `KEY_PASS`        | Your key password          |

> `GITHUB_TOKEN` is automatically injected by GitHub Actions — you do **not** need to add it manually.

Then trigger the pipeline manually:  
**Actions → build-and-release → Run workflow**

---

## Troubleshooting

| Error                                                                                                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apksigner: command not found`                                                                                          | Add Android SDK build-tools to PATH                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `apkeep: command not found`                                                                                             | Install apkeep (Step 0) and ensure it is in PATH                                                                                                                                                                                                                                                                                                                                                                                                       |
| `invalid value 'apkpure' for '--download-source'`                                                                       | apkeep ≥ 0.17.0 renamed the value to `apk-pure`. The pipeline already uses the new value; this only affects manual `apkeep` invocations.                                                                                                                                                                                                                                                                                                               |
| `apkeep produced no APK matching ...` (silent failure, exit 0, empty stdout)                                            | Pinned `GPHOTOS_VERSION` doesn't exist on APKPure. Run `apkeep -l -a com.google.android.apps.photos -d apk-pure ./tmp` to list real versions, then either pin a 4-segment match or leave the pin empty (auto-resolves latest).                                                                                                                                                                                                                         |
| `Missing required environment variables`                                                                                | Check your `.env` file has all required keys                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Missing required patch 'Spoof features'` or `'GmsCore support'`                                                        | ReVanced renamed these patches in v6 (capitalized, with spaces). Check [revanced-patches releases](https://github.com/ReVanced/revanced-patches/releases) for further drift.                                                                                                                                                                                                                                                                           |
| `Failed to fetch release for revanced-patches: HTTP 451`                                                                | Expected — the pipeline auto-falls back to `https://api.revanced.app/v5/patches`. Should not abort the build; if it does, check that your runner can reach `api.revanced.app`.                                                                                                                                                                                                                                                                         |
| `[iconRecolor] No launcher icons were recolored`                                                                        | Photos shifted its resource layout under `res/mipmap-*` or `res/drawable-*`. Cosmetic only — the build continues with the stock colored icon. Inspect the patched APK's `res/` tree (e.g. `unzip -l workspace/output-patched.apk \| grep ic_launcher`) and update the patterns in `src/core/iconRecolor.ts`.                                                                                                                                           |
| `APKEDITOR_JAR env var is not set`                                                                                      | apkeep produced an XAPK (Photos now ships split APKs) and the pipeline needs APKEditor to merge them. Install APKEditor per the Prerequisites table and set `APKEDITOR_JAR` to the jar's absolute path. CI installs it automatically.                                                                                                                                                                                                                  |
| `APKEditor merge failed: ...`                                                                                           | The merge step ran but APKEditor rejected the input. Usually a malformed/partial XAPK download — delete `workspace/com.google.android.apps.photos@*.xapk` and re-run. If it persists, run `java -jar $APKEDITOR_JAR m -i <the-xapk> -o /tmp/merged.apk -f` manually to capture the full stderr.                                                                                                                                                        |
| Install on phone: `App not installed as app isn't compatible` + CI log shows `[abiInventory] ... contains no arm64-v8a` | The build is on the APKPure fallback path and APKPure is shipping the 32-bit-only XAPK for that version. Default behavior is to fetch the universal APK from APKMirror — check the log for `[apkmirror] APKMirror path failed: ...` to see why it fell back. Usually a transient Cloudflare 403; rerun the workflow. If APKMirror is persistently blocked, pin a 7.21.x universal version in `config/versions.json` and run with `APK_SOURCE=apkpure`. |
| `[apkmirror] GET https://www.apkmirror.com/... → HTTP 403`                                                              | Cloudflare blocked the runner IP. Rerun the workflow (GitHub Actions assigns a fresh IP each run) or set `APK_SOURCE=apkpure` to skip APKMirror for that build.                                                                                                                                                                                                                                                                                        |
| `[apkmirror] No universal variant in release ...`                                                                       | APKMirror published the release without a universal variant (rare; sometimes happens for the first hours after upload). Pin `GPHOTOS_VERSION` to the previous release or wait.                                                                                                                                                                                                                                                                         |
| `HTTP 403` from GitHub API                                                                                              | Your `GITHUB_TOKEN` is invalid or expired                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Signature verification failed`                                                                                         | Keystore alias/password mismatch — regenerate with correct values                                                                                                                                                                                                                                                                                                                                                                                      |
