# Morphe Google Photos Patching & Automation Pipeline

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node: >=18.0.0](https://img.shields.io/badge/Node->=18.0.0-green.svg)](https://nodejs.org)
[![Java: >=17](<https://img.shields.io/badge/Java-%3E=17%20(64--bit)-orange.svg>)](https://www.oracle.com/java/)
[![Morphe Ecosystem](https://img.shields.io/badge/Patcher-Morphe%20CLI-purple.svg)](https://github.com/MorpheApp)

An enterprise-grade, standalone build and patching toolkit to modify **Google Photos (`com.google.android.apps.photos`)** using the modern **Morphe** ecosystem. Configured to spoof the Google Pixel XL (`marlin`) hardware footprint for **permanent, lifetime unlimited original-quality cloud backup** with zero crashes, strict sideload integrity, and seamless GmsCore (MicroG) authentication.

---

## 🏛️ Architecture & Design Philosophy

```
                                  ┌───────────────────────────────┐
                                  │   Google Photos (nodpi APK)   │
                                  │ (Monolithic Universal Binary) │
                                  └───────────────┬───────────────┘
                                                  │
                                                  ▼
┌───────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────┐
│  Morphe Patches .mpp  ├───────────►│   Morphe CLI (-Xmx4g Heap) ├───────────►│ Patched Intermediate  │
│  (MorpheApp Releases) │            │   (options.json Injected)  │            │ (classes*.dex Spoofed) │
└───────────────────────┘            └────────────────────────────┘            └───────────┬────────────┘
                                                                                           │
                                                                                           ▼
┌───────────────────────┐            ┌────────────────────────────┐            ┌────────────────────────┐
│ uber-apk-signer (JAR) ├───────────►│ 4-Byte ZipAlign + v1/v2/v3 ├───────────►│ Output Signed APK      │
│ (v1/v2/v3 Signatures) │            │   Cryptographic Signing    │            │ (Crash-Free Sideload)  │
└───────────────────────┘            └────────────────────────────┘            └────────────────────────┘
```

### Key Engineering Features:

1. **Morphe Ecosystem Transition**: Standalone toolchain decoupling from legacy ReVanced components. Utilizes `morphe-cli`, Morphe patch bundles (`.mpp`), and `options.json`.
2. **Crash Prevention & Sideload Integrity**:
   - **Monolithic `nodpi` Validation**: Validates that the input APK is a monolithic package (contains `AndroidManifest.xml` and `classes.dex`) and rejects split APK bundles (`.apkm`, `.xapk`, `.apks`, or split configs) that cause instant launch crashes.
   - **uber-apk-signer Integration**: Guarantees 4-byte memory-aligned zip structures (`zipalign`) and dual/triple cryptographic signatures (v1, v2, v3) for compatibility across Android 8.0 through Android 15+.
3. **Multi-Dex Memory Safety**: Allocates **4GB JVM Heap (`-Xmx4g`)** with modern garbage collection (`-XX:+UseG1GC`) to prevent out-of-memory crashes during smali decompilation/recompilation.
4. **Permanent Pixel XL Spoofing**: Spoofs `com.google.android.apps.photos.NEXUS_PRELOAD` and `marlin` build characteristics to unlock unlimited original-quality backups without quota consumption.
5. **GmsCore (MicroG) Integration**: Bypasses signature checking and routes Play Services authentication to standalone MicroG / GmsCore (`app.revanced.android.gms`) for non-root Google account login.

---

## 📦 Core Deliverables

| File                                         | Purpose                                                                                                                             |
| :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| [`config.json`](config.json)                 | Central pipeline configuration declaring target package, Pixel XL spoof properties, JVM flags, and GitHub release endpoints.        |
| [`options.json`](options.json)               | Morphe CLI patch options specifying hardware spoofing keys and GmsCore authentication settings.                                     |
| [`export-profile.json`](export-profile.json) | 1-click importable profile for the on-device **Morphe Manager** Android app.                                                        |
| [`build.ps1`](build.ps1)                     | Automated Windows PowerShell build script with pre-flight checks (Java 17+), dynamic GitHub asset download, and transcript logging. |
| [`build.mjs`](build.mjs)                     | Cross-platform Node.js (ESM) automation runner for CI/CD or macOS/Linux/Windows with **zero external npm dependencies**.            |
| [`package.json`](package.json)               | Project manifest with convenient scripts (`pnpm run morphe:build`, `pnpm run morphe:clean`).                                        |

---

## 📋 Prerequisites

- **Java**: 64-bit **Java 17 or Java 21** (JDK or JRE) installed and available in your `PATH`.
- **Operating System**: Windows 10/11, macOS, or Linux.
- **Node.js** (Optional for `build.mjs`): Node.js 18.0.0+ (No npm install required).
- **PowerShell** (Optional for `build.ps1`): Windows PowerShell 5.1 or PowerShell Core 7+.

---

## 🚀 Quick Start

### 1. Sourcing the Monolithic (`nodpi`) Google Photos APK

> [!IMPORTANT]
> Google Photos is distributed as both split bundles (`.apkm`/`.xapk`) and monolithic APKs. **You must use a monolithic `nodpi` universal APK.**

1. Visit [APKMirror Google Photos](https://www.apkmirror.com/apk/google-inc/photos/).
2. Select any recent version (e.g., `7.x.x`).
3. Under the **Download** table, select the variant with:
   - **Architecture**: `universal` or `arm64-v8a + armeabi-v7a`
   - **Screen DPI**: `nodpi` (Do **not** download files labeled `bundle` or `APKMs`)
4. Place the downloaded `.apk` into the `./input/` folder (e.g., `./input/GooglePhotos-nodpi.apk`).

---

### 2. Building via PowerShell (Windows)

Open PowerShell in the project directory:

```powershell
# Standard build (auto-discovers APK in ./input, fetches latest Morphe tools, patches & signs)
.\build.ps1

# Specify a custom input APK directly
.\build.ps1 -InputApk "C:\Downloads\GooglePhotos-nodpi.apk"

# Perform a clean build
.\build.ps1 -Clean
```

All build events are recorded to `./logs/build-transcript-*.log`.

---

### 3. Building via Node.js (Cross-Platform: Windows, macOS, Linux, CI/CD)

```bash
# Using pnpm / npm
pnpm run morphe:build

# Or directly with Node.js (Zero npm dependencies required)
node build.mjs

# Pass custom input APK
node build.mjs --input ./input/photos-nodpi.apk

# Clean build
node build.mjs --clean
```

The output signed APK will be saved to:
`./output/com.google.android.apps.photos-morphe-signed.apk`

---

### 4. 1-Click On-Device Patching (Morphe Manager App)

If you prefer patching directly on your Android phone using **Morphe Manager**:

1. Install [Morphe Manager](https://github.com/MorpheApp/morphe-manager/releases) on your phone.
2. Download and transfer [`export-profile.json`](export-profile.json) to your phone.
3. Open **Morphe Manager** ➔ **Settings** ➔ **Import Profile** ➔ Select `export-profile.json`.
4. Select your downloaded monolithic Google Photos APK and tap **Patch**.

---

## 📱 Sideloading & Post-Installation Setup

### Step 1: Install GmsCore (MicroG)

Because the modified Google Photos app cannot use system Google Play Services directly, install **GmsCore**:

1. Download the latest `GmsCore` APK from [ReVanced GmsCore Releases](https://github.com/ReVanced/GmsCore/releases) or [MicroG-RE Releases](https://github.com/MorpheApp/MicroG-RE/releases).
2. Install the GmsCore APK and open it once. Sign into your Google Account.

### Step 2: Install the Patched Google Photos APK

Connect your device via USB with ADB enabled, or transfer the APK to your device:

```bash
adb install -r output/com.google.android.apps.photos-morphe-signed.apk
```

---

## ⚡ Battery Optimization Whitelisting (Critical)

To ensure background backup operates continuously without being killed by OEM aggressive RAM managers:

### 1. Google Photos Whitelisting:

- Go to Android **Settings** ➔ **Apps** ➔ **Google Photos**.
- Tap **App Battery Usage** (or **Battery**).
- Change setting from _Optimized_ / _Restricted_ to **Unrestricted** (or _Don't Optimize_).
- Ensure **Allow background activity** and **Autostart** (Xiaomi/MIUI) are toggled **ON**.

### 2. GmsCore (MicroG) Whitelisting:

- Go to Android **Settings** ➔ **Apps** ➔ **GmsCore / microG Services**.
- Set Battery to **Unrestricted**.
- In GmsCore settings, verify **Google Cloud Messaging (GCM)** and **Battery Optimizations** are allowed.

---

## 🔍 Zero-Quota Verification Protocol

To verify that your photos and videos are backing up under the **Pixel XL Unlimited Original Quality** entitlement without counting against your Google One 15GB quota:

1. Open the patched **Google Photos** app.
2. Tap your **Profile Picture** in the top right corner.
3. Tap **Google Photos settings** ➔ **Backup**.
4. Confirm the banner reads:
   > 🌟 **"This Pixel can back up unlimited photos & videos at no charge."**
5. Back up a sample large video (e.g., 4K 100MB+ clip).
6. Verify on [one.google.com/storage](https://one.google.com/storage) on a web browser that your **Google Photos storage used** did **NOT** increase by a single byte.

---

## 🛠️ Operational Troubleshooting Matrix

| Issue / Symptom                                                              | Root Cause                                           | Remediation                                                                                                     |
| :--------------------------------------------------------------------------- | :--------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **`CRITICAL INTEGRITY REJECTION: ... is a split bundle`**                    | Downloaded `.apkm`, `.xapk`, or multi-split bundle.  | Obtain a monolithic `nodpi` APK from APKMirror.                                                                 |
| **Out of Memory (`java.lang.OutOfMemoryError: Java heap space`)**            | Multi-dex processing exceeded standard heap limit.   | Ensure 64-bit Java 17+ is used. The script automatically supplies `-Xmx4g`.                                     |
| **"GMS Core is not installed" or Sign-in Spinner Infinite Loop**             | Standalone GmsCore is missing or battery killed.     | Install [GmsCore](https://github.com/ReVanced/GmsCore/releases) and set battery optimization to _Unrestricted_. |
| **App crashes immediately on launch (SIGSEGV / ClassNotFound)**              | Corrupt dex or missing native library ABI mismatch.  | Ensure the input APK was `nodpi` and signed with `uber-apk-signer` (v1/v2/v3 enabled).                          |
| **`Signature verification failed` / `INSTALL_PARSE_FAILED_NO_CERTIFICATES`** | Incomplete zip alignment or broken signature scheme. | `uber-apk-signer` automatically signs with v1, v2, and v3 schemes. Run with `--clean` to regenerate.            |
| **GitHub API Rate Limit (`HTTP 403 Forbidden`)**                             | Exceeded unauthenticated rate limit (60 req/hr).     | Set your GitHub token in environment: `$env:GITHUB_TOKEN="ghp_..."` or `export GITHUB_TOKEN="ghp_..."`.         |

---

## 📄 License & Compliance

Distributed under the **GPL-3.0 License**.

_Disclaimer: This tooling is intended for personal research and educational workflows. Google Photos and Pixel are registered trademarks of Google LLC. This project is not affiliated with Google LLC._
