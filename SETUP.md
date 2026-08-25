# Setup Guide

Complete setup, build, and deployment instructions for the Morphe Google Photos pipeline.

---

## System Requirements

| Requirement             | Version              | Purpose                                |
| :---------------------- | :------------------- | :------------------------------------- |
| Java (JDK/JRE)          | 64-bit Java 17 or 21 | Runs Morphe CLI and uber-apk-signer    |
| Node.js _(optional)_    | v18.0.0+ / v20 LTS   | Runs `build.mjs` cross-platform runner |
| PowerShell _(optional)_ | 5.1 / Core 7+        | Runs `build.ps1` on Windows            |
| ADB                     | Platform Tools 34+   | Sideloads APKs to device               |

> [!TIP]
> Download OpenJDK 21 LTS from [Adoptium Temurin](https://adoptium.net/temurin/releases/?version=21). Verify with `java -version`.

---

## Step 1: Obtain the Input APK

The input must be a monolithic universal APK. Split bundles cause launch crashes.

1. Go to [APKMirror — Google Photos](https://www.apkmirror.com/apk/google-inc/photos/).
2. Select a recent version.
3. Download the variant with **universal** architecture and **nodpi** DPI. Do not download bundles.
4. Place the `.apk` in `input/`:
   ```
   photos-revanced/
   └── input/
       └── com.google.android.apps.photos_7.xx.apk
   ```

---

## Step 2: Build the Patched APK

### Option A: PowerShell (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1                              # standard
powershell -ExecutionPolicy Bypass -File .\build.ps1 -SkipDownload                # use cached tools
powershell -ExecutionPolicy Bypass -File .\build.ps1 -InputApk "C:\path\to.apk"  # custom input
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean                       # clean build
```

### Option B: Node.js (cross-platform)

No `npm install` required.

```bash
node build.mjs                            # standard
node build.mjs --skip-download            # use cached tools
node build.mjs --input ./input/photos.apk # custom input
node build.mjs --clean                    # clean build
```

---

## Step 3: Deploy to Device

### Install GmsCore

If not already installed, download [GmsCore](https://github.com/ReVanced/GmsCore/releases) and install it. Sign in to your Google account.

### Sideload via ADB

```bash
adb install -r "output/com.google.android.apps.photos-morphe-signed.apk"
```

### Whitelist Battery Optimization

```bash
adb shell dumpsys deviceidle whitelist +app.revanced.android.gms
adb shell dumpsys deviceidle whitelist +app.morphe.android.apps.photos
adb shell dumpsys deviceidle whitelist +com.google.android.apps.photos
```

Or manually: Settings > Apps > GmsCore / Google Photos > Battery > Unrestricted.

---

## Step 4: Verify Unlimited Backup

1. Open Google Photos > Profile > Settings > Backup.
2. Confirm: **"This Pixel can back up unlimited photos & videos at no charge."**
3. Upload a test file. Verify at [one.google.com/storage](https://one.google.com/storage) that quota did not increase.

---

## Step 5: CI/CD (GitHub Actions)

The workflow at [`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml) triggers on:

- Push to `main`
- Weekly schedule (Sunday 02:00 UTC)
- Manual `workflow_dispatch`

### Keystore Secrets (optional)

For release signing in CI, set these repository secrets:

| Secret            | Value                                |
| :---------------- | :----------------------------------- |
| `KEYSTORE_BASE64` | Base64-encoded `.jks` or `.keystore` |
| `KEY_ALIAS`       | Keystore alias                       |
| `KEY_STORE_PASS`  | Keystore password                    |
| `KEY_PASS`        | Private key password                 |

If not set, uber-apk-signer generates a debug certificate automatically.
