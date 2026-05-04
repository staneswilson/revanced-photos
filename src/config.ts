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
    patchName: 'spoof-features',
  },
  requiredPatches: [
    { name: 'spoof-features',   required: true  },
    { name: 'gmscore-support',  required: true  },
  ],
  paths: {
    workspace:    'workspace',
    inputApk:     'workspace/input.apk',
    patchedApk:   'workspace/output-patched.apk',
    signedApk:    'workspace/output-signed.apk',
    magiskZip:    'workspace/magisk-revanced-gphotos.zip',
    optionsJson:  'workspace/options.json',
    releaseMeta:  'workspace/meta.json',
    releaseNotes: 'workspace/release-notes.md',
    toolsDir:     'workspace/tools',
  },
  envKeys: {
    githubToken:   'GITHUB_TOKEN',
    keystoreB64:   'KEYSTORE_BASE64',
    keyAlias:      'KEY_ALIAS',
    keyStorePass:  'KEY_STORE_PASS',
    keyPass:       'KEY_PASS',
    gphotosVersion:'GPHOTOS_VERSION',   // Optional — pin a specific version
    skipMagisk:    'SKIP_MAGISK',        // Optional — set 'true' to skip
  },
});
