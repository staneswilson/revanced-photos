# ReVanced Google Photos Pipeline

[![build-and-release](https://github.com/staneswilson/revanced-photos/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/staneswilson/revanced-photos/actions/workflows/build-and-release.yml)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Latest release](https://img.shields.io/github/v/release/staneswilson/revanced-photos?include_prereleases&label=release)](https://github.com/staneswilson/revanced-photos/releases/latest)

An automated GitHub Actions pipeline that patches Google Photos with [ReVanced](https://revanced.app) to spoof the Pixel XL (`marlin`) device fingerprint. Pixel XL was sold with a permanent, account-bound entitlement to **unlimited original-quality Google Photos backups** — by making the app report itself as a Pixel XL, the entitlement is granted to the signed-in account regardless of the actual device.

The pipeline runs weekly, fetches the latest patch-compatible Google Photos APK from APKPure, applies the ReVanced `Spoof features` and `GmsCore support` patches, signs the result with your keystore, and publishes the artifacts as a GitHub Release.

## What you get on every release

- `output-signed.apk` — patched, re-signed Google Photos APK. Install on a non-rooted device alongside [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases).
- `magisk-revanced-gphotos.zip` — Magisk / KernelSU module that replaces the system Google Photos at boot. For rooted devices.
- `release-notes.md` + `meta.json` — the exact Photos version, ReVanced CLI version, patches version, and SHA-256 of the signed APK.

The patched APK ships with a **grayscaled launcher icon** so it's visually distinct from the stock Google Photos on devices where both are installed. Set `SKIP_ICON_RECOLOR=true` to keep the original colored icon.

## How it works

1. **Resolve version + fetch APK** — by default the pipeline scrapes [APKMirror](https://www.apkmirror.com/apk/google-inc/photos/) for the latest Photos release and downloads its **Universal** variant (all ABIs in one file). APKMirror is preferred because APKPure now ships 32-bit-only split bundles for recent versions, which won't install on 64-bit-only Android (Pixel 7+). If APKMirror is unreachable (Cloudflare 403, page redesign), the pipeline automatically falls back to APKPure via `apkeep`, merging any XAPK splits with [APKEditor](https://github.com/REAndroid/APKEditor). Override the version with `GPHOTOS_VERSION` (accepts 3-segment `7.76.0` or 4-segment `7.76.0.913939682`). Force a specific source with `APK_SOURCE=apkmirror` (default) or `APK_SOURCE=apkpure`.
2. **Fetch tooling** — ReVanced CLI v6 from `github.com/ReVanced/revanced-cli` (SHA-256 verified via the asset `digest` field). Patches RVP from `github.com/ReVanced/revanced-patches`, with automatic fallback to `https://api.revanced.app/v5/patches` when GitHub returns HTTP 451.
3. **Patch** — `revanced-cli patch -p patches.rvp -b -e "Spoof features" -e "GmsCore support" -o output.apk input.apk`. The `Spoof features` patch defaults to enabling `NEXUS_PRELOAD` (Pixel XL) and disabling all newer Pixel features — exactly the unlimited-storage configuration.
4. **Sign + package** — `apksigner` re-signs with your keystore (Base64-injected via GitHub Secrets, written 0o600, secure-wiped after use). The signed APK is then bundled into a Magisk module via `archiver`.

See [docs/architecture.md](docs/architecture.md) for the data flow and threat model.

## Quick start

1. Fork the repo.
2. Generate a signing keystore: `keytool -genkeypair -keystore release.jks -alias revanced -keyalg RSA -keysize 2048 -validity 10000`.
3. Add four repository secrets under **Settings → Secrets and variables → Actions**: `KEYSTORE_BASE64` (your `.jks` Base64-encoded), `KEY_ALIAS`, `KEY_STORE_PASS`, `KEY_PASS`.
4. Trigger the **build-and-release** workflow from the **Actions** tab.

Detailed setup (including local builds): [SETUP.md](SETUP.md).

## Installation

### Non-rooted devices (signed APK + MicroG)

1. Install [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases). Required — without it the patched app cannot reach Google services.
2. Download `output-signed.apk` from the [latest release](https://github.com/staneswilson/revanced-photos/releases/latest).
3. Install the APK. Sign in with your Google account.

### Rooted devices (Magisk / KernelSU module)

1. Install [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases). **Still required on rooted devices** — the `GmsCore support` patch routes the app's Play Services calls to GmsCore regardless of root. Without it the app errors out with "GMS Core is not installed."
2. Download `magisk-revanced-gphotos.zip` from the [latest release](https://github.com/staneswilson/revanced-photos/releases/latest).
3. Magisk → Modules → Install from storage → select the zip.
4. Reboot. The patched app replaces the stock Google Photos at the system level.

## Security properties

Concrete things the pipeline does, in order of strength:

- **Pinned GitHub Action SHAs.** All actions are referenced by full commit SHA, not floating tags — no supply-chain swap via tag re-pointing.
- **No binaries in git.** `.gitignore` enforces no `.apk`, `.jks`, or keystore artifacts are tracked.
- **Ephemeral keystore.** Decoded from Base64 secret at runtime, written with `0o600` permissions, secure-wiped (random overwrite + unlink) in a `try/finally` block — wiped even if the build crashes.
- **No shell interpolation.** All external invocations use Node's `child_process.execFile` with explicit argument arrays. Package names, versions, and paths cannot break out into shell commands.
- **SHA-256 verification (best effort).** ReVanced CLI and integrations are verified against the digest published by the upstream release. The patches RVP is verified when sourced from GitHub. When the v5 API fallback is used (because GitHub returns 451), the API publishes no SHA-256 — integrity rests on TLS to `api.revanced.app`. The asset is GPG-signed via the `signature_download_url` sidecar; verifying that signature against ReVanced's public key is the planned next hardening step.

## FAQ

**Why Pixel XL specifically?**
Google grandfathered unlimited original-quality Photos backups for the original Pixel and Pixel XL (codenames `sailfish` and `marlin`). The entitlement is checked client-side via the `com.google.android.apps.photos.NEXUS_PRELOAD` system feature, which the `Spoof features` patch can fake on any device.

**Do I need root?**
No. The signed APK + [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases) path works on stock Android. Root is optional and unlocks the Magisk module path, which seamlessly replaces the system Google Photos.

**Why APKMirror instead of APKPure?**
APKPure now uploads recent Google Photos as split-APK bundles that contain only `config.armeabi_v7a.apk` — there is no `arm64-v8a` native library inside, so the merged APK refuses to install on 64-bit-only Android (Pixel 7 and newer, recent flagships). APKMirror still ships true universal APKs (all ABIs in one file), so it produces a build that installs everywhere. The pipeline keeps APKPure as an automatic fallback in case APKMirror blocks the CI runner.

**Will Google block this eventually?**
Possibly. Google has progressively tightened device attestation for some services. The project is best-effort — when ReVanced patches are updated to handle Google's changes, the next weekly build picks them up automatically.

**Is it safe to put my Google account on a patched APK?**
You're installing a modified version of a Google application. Treat it like any third-party app: review what the pipeline does (the source is in this repo, the build is reproducible from CI), and decide. The patches modify only client-side feature reporting; they don't add network code or telemetry.

## Disclaimer

This project is not affiliated with, sponsored by, or endorsed by Google LLC, ReVanced, MicroG, KernelSU, or Magisk. "Google Photos", "Pixel", and "Pixel XL" are trademarks of Google LLC. "Magisk" and "KernelSU" are trademarks of their respective owners. The project is provided as-is, intended for personal use of your own Google account, and ships under the terms below. You are responsible for complying with Google's terms of service and any local laws.

## License

[GPL-3.0](LICENSE), consistent with the ReVanced ecosystem.
