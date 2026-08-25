# Setup & Execution Guide — Morphe Google Photos Toolkit

This guide covers everything needed to configure, build, and deploy patched **Google Photos** APKs with **unlimited original-quality cloud storage** using the standalone **Morphe** toolchain.

---

## 📋 System Prerequisites

| Requirement                    | Supported Version                          | Purpose                                                    |
| :----------------------------- | :----------------------------------------- | :--------------------------------------------------------- |
| **Java Runtime (JDK/JRE)**     | **64-bit Java 17 or Java 21**              | Executes Morphe Desktop CLI patcher & `uber-apk-signer`    |
| **Node.js** (Optional)         | **v18.0.0+ / v20 LTS**                     | Runs the zero-dependency cross-platform runner `build.mjs` |
| **PowerShell** (Optional)      | **Windows PowerShell 5.1 / PowerShell 7+** | Runs `build.ps1` automated runner on Windows               |
| **ADB (Android Debug Bridge)** | Platform Tools 34+                         | Sideloads APKs and manages battery whitelist on device     |

> [!TIP]
> Download OpenJDK 21 LTS from [Adoptium Temurin](https://adoptium.net/temurin/releases/?version=21). Verify Java is on your PATH by running `java -version`.

---

## 🛠️ Step 1: Obtain a Monolithic `nodpi` Google Photos APK

To prevent launch crashes caused by split-APK dependencies, you must supply a monolithic universal APK:

1. Go to [APKMirror Google Photos Releases](https://www.apkmirror.com/apk/google-inc/photos/).
2. Select any recent Google Photos release (e.g. `7.x.x`).
3. In the variant list, download the file with:
   - **Architecture**: `universal` (or `arm64-v8a + armeabi-v7a`)
   - **DPI**: `nodpi` (Do not download `APKMs` / Split Bundles)
4. Save the `.apk` file into the `input/` folder in the project root:
   ```
   photos-revanced/
   └── input/
       └── com.google.android.apps.photos_7.xx.apk
   ```

---

## 🚀 Step 2: Build & Sign the Patched APK

You can build using either PowerShell or Node.js.

### Option A: Windows PowerShell (`build.ps1`)

```powershell
# Standard build (auto-discovers APK in ./input, caches tools, patches, and signs)
powershell -ExecutionPolicy Bypass -File .\build.ps1

# Build with tool caching enabled (fastest rebuild)
powershell -ExecutionPolicy Bypass -File .\build.ps1 -SkipDownload

# Build with a custom input APK
powershell -ExecutionPolicy Bypass -File .\build.ps1 -InputApk "C:\Downloads\gphotos.apk"

# Full clean build (purges temp, cached tools, logs, and output)
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Clean
```

### Option B: Cross-Platform Node.js (`build.mjs`)

Works across Windows, macOS, Linux, and CI/CD without needing `npm install`:

```bash
# Standard build
node build.mjs

# Build with tool caching enabled
node build.mjs --skip-download

# Custom APK path
node build.mjs --input ./input/photos.apk

# Clean build
node build.mjs --clean
```

---

## 📱 Step 3: Deploy to Android Device

### 1. Install MicroG / GmsCore

If not already installed on your device, download and install the latest **GmsCore**:
👉 [ReVanced GmsCore Releases](https://github.com/ReVanced/GmsCore/releases)

### 2. Sideload the Patched APK via ADB

Connect your Android device via USB (with USB Debugging enabled) and run:

```cmd
adb install -r "output\com.google.android.apps.photos-morphe-signed.apk"
```

### 3. Whitelist Battery Optimizations

To allow background photo backup to sync without being paused by Android's Doze mode:

```cmd
:: Instant 1-line whitelist via ADB
adb shell dumpsys deviceidle whitelist +app.revanced.android.gms
adb shell dumpsys deviceidle whitelist +app.morphe.android.apps.photos
adb shell dumpsys deviceidle whitelist +com.google.android.apps.photos
```

_Or manually on device:_ Open **Settings** ➔ **Apps** ➔ **GmsCore** (and **Google Photos**) ➔ **Battery** ➔ **Unrestricted** / **Don't Optimize**.

---

## 🔍 Step 4: Storage Quota Verification

1. Open the patched Google Photos app and sign in with your Google account.
2. Tap your **Profile Icon** (top-right) ➔ **Google Photos settings** ➔ **Backup**.
3. Confirm the unlimited backup banner:
   > 🌟 **"This Pixel can back up unlimited photos & videos at no charge."**
4. Take a test photo or video and allow it to upload.
5. Check [one.google.com/storage](https://one.google.com/storage) on a web browser to verify that Google Photos storage did **not** increase.

---

## 🌐 Step 5: Continuous Integration (GitHub Actions)

The project includes an automated GitHub Actions release workflow at [`.github/workflows/build-and-release.yml`](.github/workflows/build-and-release.yml).

### Automatic Triggers:

- **Git Push to `main`**: Automatically triggers build & release.
- **Weekly Schedule**: Every Sunday at 02:00 UTC.
- **Manual Trigger**: Under the **Actions** tab via `workflow_dispatch`.

### Custom Keystore Secrets (Optional for CI/CD):

To sign releases with your personal release certificate in CI/CD, set these repository secrets in GitHub:

- `KEYSTORE_BASE64`: Base64-encoded `.keystore` or `.jks` file.
- `KEY_ALIAS`: Keystore alias name.
- `KEY_STORE_PASS`: Keystore password.
- `KEY_PASS`: Private key password.

If no secrets are configured, `uber-apk-signer` automatically generates and signs with a resilient, auto-aligned debug certificate.
