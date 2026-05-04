# Setup & Run Guide — Google Photos ReVanced Pipeline

This guide covers everything needed to run the pipeline **locally** (Windows) or via **GitHub Actions** (CI/CD).

---

## Prerequisites

Make sure the following tools are installed and available in your `PATH`:

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 8 | `npm i -g pnpm` |
| Java (JDK) | ≥ 17 | [adoptium.net](https://adoptium.net) |
| Android SDK Build-Tools | 34.x | via Android Studio SDK Manager |
| apkeep | 0.17.0 | See below |

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

### Verify `apksigner` is on PATH

```powershell
# It lives inside Android SDK build-tools. Add it to PATH or run directly:
$env:Path += ";$env:LOCALAPPDATA\Android\Sdk\build-tools\34.0.0"
apksigner --version
```

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
# GPHOTOS_VERSION=6.91.0.636766573
# SKIP_MAGISK=true
```

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

| Secret Name | Value |
|-------------|-------|
| `KEYSTORE_BASE64` | Contents of `keystore.b64` |
| `KEY_ALIAS` | `revanced` (or your alias) |
| `KEY_STORE_PASS` | Your keystore password |
| `KEY_PASS` | Your key password |

> `GITHUB_TOKEN` is automatically injected by GitHub Actions — you do **not** need to add it manually.

Then trigger the pipeline manually:  
**Actions → build-and-release → Run workflow**

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `apksigner: command not found` | Add Android SDK build-tools to PATH |
| `apkeep: command not found` | Install apkeep (Step 0) and ensure it is in PATH |
| `Missing required environment variables` | Check your `.env` file has all required keys |
| `Missing required patch 'spoof-features'` | ReVanced updated their patch names — check [revanced-patches releases](https://github.com/ReVanced/revanced-patches/releases) |
| `HTTP 403` from GitHub API | Your `GITHUB_TOKEN` is invalid or expired |
| `Signature verification failed` | Keystore alias/password mismatch — regenerate with correct values |
