# ReVanced Google Photos Pipeline

An automated, highly secure CI/CD pipeline that patches Google Photos using the ReVanced toolchain to spoof the Pixel XL (marlin) device fingerprint. This unlocks unlimited original-quality backups on your Google account.

**Note:** This pipeline creates a client-side spoof. To use the patched app, non-rooted users must install MicroG (or GmsCore). Rooted users can flash the provided Magisk module to seamlessly replace the system app.

## Features & Architecture

*   **Fully Automated:** A GitHub Action fetches the base APK, downloads ReVanced components, verifies their checksums, patches the app, signs it, and publishes a Release.
*   **Zero Binaries Committed:** Clean repository — no `.apk` or `.keystore` files in your git history.
*   **Security First:** 
    *   SHA-256 cryptographic verification of all downloaded ReVanced tools.
    *   Ephemeral keystores injected via GitHub Secrets and securely wiped after signing.
    *   No shell injection (strict `execFile` implementation).
    *   GitHub Action versions are strictly pinned by SHA to prevent supply-chain attacks.

See [docs/architecture.md](docs/architecture.md) for detailed data flows and threat mitigations.

---

## Prerequisites

To run this pipeline locally or fork it for your own GitHub Actions, you need:

1.  **Node.js 20+** and **pnpm 8+**
2.  **Java 17+** (Required by ReVanced CLI and `apksigner`)
3.  **Android Build Tools** (specifically `apksigner`)
4.  **apkeep** (CLI tool for downloading APKs)

---

## Setup Guide (Fork & Deploy)

Follow these steps to deploy your own automated builder:

### 1. Fork the Repository
Fork this repository to your own GitHub account.

### 2. Generate a Signing Keystore
You need your own cryptographic key to sign the output APK. Run the following command in your terminal (do **not** commit this file):

\`\`\`bash
keytool -genkey -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias myalias
\`\`\`

*Remember the Keystore Password and the Key Password you enter.*

### 3. Encode the Keystore to Base64
GitHub Secrets require text. Encode your `.jks` file:

**Linux / WSL:**
\`\`\`bash
base64 -w 0 release.jks > keystore.b64
\`\`\`

**macOS:**
\`\`\`bash
base64 -i release.jks | tr -d '\n' > keystore.b64
\`\`\`

### 4. Configure GitHub Secrets
Go to your forked repository's **Settings > Secrets and variables > Actions** and add the following **Repository secrets** (the names must match exactly):

| Secret Name | Description |
|---|---|
| \`KEYSTORE_BASE64\` | The exact contents of your `keystore.b64` file. |
| \`KEY_ALIAS\` | The alias you used in Step 2 (e.g., `myalias`). |
| \`KEY_STORE_PASS\` | The keystore password. |
| \`KEY_PASS\` | The key password. |

### 5. Trigger the Build
1. Go to the **Actions** tab in your repository.
2. Select the **build-and-release** workflow.
3. Click **Run workflow**.

The action will run, fetch the latest APK, patch it, sign it, and publish a new Release containing your `.apk` and `.zip` files.

---

## Installation Paths

### Option A: Non-Rooted Devices (Standard APK)
1. Download and install [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases). This is strictly required to log in.
2. Download the `output-signed.apk` from the latest GitHub Release.
3. Install the APK.

### Option B: Rooted Devices (Magisk Module)
This is the recommended path for rooted users. It replaces the system Google Photos app.
1. Download the `magisk-revanced-gphotos.zip` from the latest GitHub Release.
2. Open the Magisk or KernelSU app.
3. Go to Modules -> Install from storage, and select the zip.
4. Reboot your device.

---

## Version Pinning Automation

This repository separates version detection from the build pipeline. 
- The `check-update.yml` workflow runs weekly, queries APKPure for the latest Google Photos version, and opens a Pull Request updating `config/versions.json`.
- The `build-and-release.yml` workflow runs weekly to build the version specified in `versions.json`. 

You can manually force a specific version by setting a `GPHOTOS_VERSION` repository secret.

---

## License

This project is licensed under the GPL-3.0 License, consistent with the ReVanced ecosystem.
