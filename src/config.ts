export const CONFIG = Object.freeze({
  packageName: 'com.google.android.apps.photos',
  revanced: {
    org: 'ReVanced',
    cliRepo: 'revanced-cli',
    patchesRepo: 'revanced-patches',
    integrationsRepo: 'revanced-integrations',
  },
  spoofTarget: {
    manufacturer: 'Google',
    model: 'Pixel XL',
    product: 'marlin',
  },
  // ReVanced patches v6 patch names (capitalized, with spaces). The "Spoof
  // features" patch ships with defaults that already enable NEXUS_PRELOAD
  // (Pixel XL) and disable all newer Pixel features — exactly the unlimited-
  // storage configuration — so no per-option overrides are needed.
  requiredPatches: [
    { name: 'Spoof features', required: true },
    { name: 'GmsCore support', required: true },
  ],
  paths: {
    workspace: 'workspace',
    inputApk: 'workspace/input.apk',
    patchedApk: 'workspace/output-patched.apk',
    signedApk: 'workspace/output-signed.apk',
    magiskZip: 'workspace/magisk-revanced-gphotos.zip',
    releaseMeta: 'workspace/meta.json',
    releaseNotes: 'workspace/release-notes.md',
    toolsDir: 'workspace/tools',
  },
  envKeys: {
    githubToken: 'GITHUB_TOKEN',
    keystoreB64: 'KEYSTORE_BASE64',
    keyAlias: 'KEY_ALIAS',
    keyStorePass: 'KEY_STORE_PASS',
    keyPass: 'KEY_PASS',
    gphotosVersion: 'GPHOTOS_VERSION', // Optional — pin a specific version
    skipMagisk: 'SKIP_MAGISK', // Optional — set 'true' to skip
    skipIconRecolor: 'SKIP_ICON_RECOLOR', // Optional — set 'true' to keep stock icon
    apkeditorJar: 'APKEDITOR_JAR', // Required only when apkeep yields an XAPK
  },
});
