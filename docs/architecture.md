# Architecture

Data flow, component responsibilities, and security model for the Morphe Google Photos pipeline.

---

## Pipeline Flow

```mermaid
graph TD
    A[Trigger: CLI or GitHub Actions] --> B[Pre-flight: Java 21 64-bit + Node 20]
    B --> C[APK Discovery and Monolithic nodpi Validation]
    C --> D[Toolchain Resolution via GitHub API]
    D --> E[Download and Cache: morphe-cli, patches.mpp, uber-apk-signer]
    E --> F[Inject options.json: Spoof config + GmsCore auth]
    F --> G[Morphe CLI JVM Process with -Xmx4g Heap]
    G --> H[Smali Bytecode Modification and Resource Sanitization]
    H --> I[Compile Patched Multi-Dex and Modified Resources]
    I --> J[uber-apk-signer: ZipAlign + v1/v2/v3 Signing]
    J --> K[SHA-256 Digest Verification and Artifact Packaging]
    K --> L[Output: com.google.android.apps.photos-morphe-signed.apk]
```

---

## Components

### Morphe CLI

- Binary: `morphe-desktop-all.jar` from `MorpheApp/morphe-cli`
- Heap: `-Xmx4g -XX:+UseG1GC` to handle large (~200MB+) DEX files without OOM
- Injects runtime hooks into Dalvik/ART bytecode without breaking DEX structure

### Patch Bundle (`patches.mpp`)

Source: `RookieEnough/De-Vanced` or official Morphe patch repository.

Applied patches:

1. **Spoof features** — enables `NEXUS_PRELOAD` and `nexus_preload`, masks post-2016 Pixel flags
2. **GmsCore support** — redirects Play Services auth to standalone MicroG (`app.revanced.android.gms`)
3. **Fix selected account persistence** — prevents account clearing across app restarts

### uber-apk-signer

- Binary: `uber-apk-signer.jar` from `patrickfav/uber-apk-signer`
- 4-byte zipalign for `mmap()`-optimized layouts
- Signs with v1 (JAR), v2 (APK Signature Scheme v2), and v3 (v3 scheme)

---

## Security Model

### Supply Chain

Toolchain assets are resolved from verified GitHub release repos over TLS. Downloaded to `./tools/` and validated before execution.

### Keystore Management

- CI: keystore supplied via encrypted repo secrets (`KEYSTORE_BASE64`, `KEY_STORE_PASS`, `KEY_ALIAS`, `KEY_PASS`), decoded into ephemeral runtime storage, never committed (enforced by `.gitignore`)
- Local: uber-apk-signer auto-generates a debug certificate if no keystore is provided

### Argument Injection Protection

All external process calls in `build.ps1` and `build.mjs` pass arguments via typed arrays (argv), not shell string interpolation. Prevents injection when handling arbitrary paths or env vars.

---

## Backup Spoofing Mechanism

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant App as Google Photos (Patched)
    participant Gms as GmsCore (MicroG)
    participant Server as Google Photos Cloud API

    User->>App: Launch and sign in
    App->>Gms: Request OAuth 2.0 token
    Gms-->>App: Return auth token
    App->>App: Query device entitlements (Spoof features hook)
    Note over App: Injects NEXUS_PRELOAD + Pixel XL marlin model
    App->>Server: Upload media (original quality)
    Note over Server: Evaluates device fingerprint as Pixel XL (2016)
    Server-->>App: Upload succeeded (quota billed: 0 bytes)
```

1. Google Photos queries system feature flags via `PackageManager.hasSystemFeature()`.
2. The Spoof features patch intercepts these calls and asserts `com.google.android.apps.photos.NEXUS_PRELOAD` is present.
3. Google's upload endpoint applies the grandfathered 2016 Pixel XL policy: unlimited original-quality storage with zero quota deduction.
