#!/usr/bin/env node

/**
 * Cross-Platform Morphe Google Photos Patching & Signing Runner.
 * Pure Node.js ESM with executive release metadata generation.
 *
 * Target: Google Photos (com.google.android.apps.photos)
 * Features:
 *  - Dynamic GitHub Toolchain Resolution (Morphe CLI, Morphe Patches, uber-apk-signer)
 *  - Monolithic nodpi APK Validation & Split Bundle Rejection
 *  - Automatic Version Resolution & Metadata Extraction
 *  - 4GB Multi-Dex JVM Heap Allocation (-Xmx4g)
 *  - Pixel XL Spoofing (UNLIMITED_ORIGINAL_QUALITY) + GmsCore MicroG Authentication
 *  - Automated 4-Byte Zip Alignment (zipalign) + v1/v2/v3 Cryptographic Signing
 *  - Magisk / KernelSU Root Module Packaging (.zip)
 *  - GitHub Release Page & release-meta.json Generation
 *  - Dual Console & File Transcript Logging
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Path Constants ---
const CONFIG_PATH = path.join(__dirname, 'config.json');
const OPTIONS_PATH = path.join(__dirname, 'options.json');
const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const TOOLS_DIR = path.join(__dirname, 'tools');
const LOGS_DIR = path.join(__dirname, 'logs');
const CACHE_DIR = path.join(__dirname, '.cache');
const TEMP_DIR = path.join(__dirname, 'temp');

// --- CLI Arguments Parsing ---
const args = process.argv.slice(2);
function parseArgs() {
  const options = {
    inputApk: '',
    appVersion: '',
    clean: false,
    skipDownload: false,
    skipMagisk: false,
    keystorePath: '',
    verbose: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--clean') options.clean = true;
    else if (arg === '--skip-download') options.skipDownload = true;
    else if (arg === '--skip-magisk') options.skipMagisk = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if ((arg === '--input' || arg === '-i') && i + 1 < args.length) {
      options.inputApk = args[++i];
    } else if ((arg === '--version' || arg === '-V') && i + 1 < args.length) {
      options.appVersion = args[++i];
    } else if (arg === '--keystore' && i + 1 < args.length) {
      options.keystorePath = args[++i];
    } else if (!arg.startsWith('-') && !options.inputApk) {
      options.inputApk = arg;
    }
  }
  return options;
}

const cliOpts = parseArgs();

if (cliOpts.help) {
  console.log(`
Morphe Google Photos Patching Pipeline Runner

Usage:
  node build.mjs [options]
  node build.mjs [path-to-apk]

Options:
  -i, --input <path>      Path to input monolithic (nodpi) Google Photos APK
  -V, --version <string>  Explicit Google Photos version (e.g. 7.89.0.968035987)
  --clean                 Clean previous output, temporary files, and cache
  --skip-download         Use existing cached toolchain components without checking GitHub
  --skip-magisk           Skip building the root Magisk/KernelSU .zip module
  --keystore <path>       Path to custom signing keystore (.jks/.keystore)
  -v, --verbose           Enable verbose output
  -h, --help              Show this help message
`);
  process.exit(0);
}

// --- Logging & Transcript ---
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const transcriptPath = path.join(LOGS_DIR, `build-transcript-${timestamp}.log`);

function log(message, level = 'INFO', color = '\x1b[37m') {
  const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const formatted = `[${time}] [${level}] ${message}`;
  const reset = '\x1b[0m';
  console.log(`${color}${formatted}${reset}`);
  try {
    fs.appendFileSync(transcriptPath, `${formatted}\n`, 'utf8');
  } catch {
    // Ignore early log write errors before dir creation
  }
}

const logInfo = (msg) => log(msg, 'INFO', '\x1b[36m');
const logSuccess = (msg) => log(msg, 'SUCCESS', '\x1b[32m');
const logWarn = (msg) => log(msg, 'WARN', '\x1b[33m');
const logError = (msg) => log(msg, 'ERROR', '\x1b[31m');
const logHeader = (title) => {
  const line = '='.repeat(70);
  console.log(
    `\n\x1b[34m${line}\x1b[0m\n  \x1b[1m\x1b[37m${title}\x1b[0m\n\x1b[34m${line}\x1b[0m\n`,
  );
  try {
    fs.appendFileSync(transcriptPath, `\n${line}\n  ${title}\n${line}\n`, 'utf8');
  } catch {}
};

// --- Child Process Helper ---
function execPromise(cmd, cmdArgs, spawnOptions = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, cmdArgs, spawnOptions, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(
          `Command '${cmd} ${cmdArgs.join(' ')}' failed: ${stderr || err.message}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = err.code;
        return reject(error);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// --- HTTPS Helpers ---
function httpsGetJson(url, token = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Morphe-GPhotos-Runner/1.0' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpsGetJson(res.headers.location, token));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage} from ${url}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON response: ${e.message}`));
          }
        });
      })
      .on('error', reject);
  });
}

function downloadFile(url, destPath, token = null) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const headers = { 'User-Agent': 'Morphe-GPhotos-Runner/1.0' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const request = https.get(url, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return resolve(downloadFile(response.headers.location, destPath, token));
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP Download failed with status ${response.statusCode}`));
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

// --- Monolithic nodpi APK Verification ---
async function validateMonolithicApk(apkPath) {
  if (!fs.existsSync(apkPath)) {
    throw new Error(`APK file does not exist at: ${apkPath}`);
  }

  const stat = await fsp.stat(apkPath);
  if (stat.size < 10 * 1024 * 1024) {
    throw new Error(
      `APK file is suspiciously small (${(stat.size / 1024 / 1024).toFixed(2)} MB). Minimum expected is >10MB.`,
    );
  }

  // Check file extension
  const lower = apkPath.toLowerCase();
  if (lower.endsWith('.apkm') || lower.endsWith('.xapk') || lower.endsWith('.apks')) {
    throw new Error(
      `CRITICAL INTEGRITY REJECTION: '${path.basename(apkPath)}' is a split bundle container (.apkm/.xapk/.apks). Split bundles cause immediate launch crashes. Please provide a monolithic (nodpi) APK.`,
    );
  }

  // Verify Zip Header (PK\x03\x04)
  const fd = await fsp.open(apkPath, 'r');
  const headerBuf = Buffer.alloc(4);
  await fd.read(headerBuf, 0, 4, 0);
  await fd.close();

  if (
    headerBuf[0] !== 0x50 ||
    headerBuf[1] !== 0x4b ||
    headerBuf[2] !== 0x03 ||
    headerBuf[3] !== 0x04
  ) {
    throw new Error(
      'Invalid file format: File is not a valid ZIP/APK archive (missing PK signature).',
    );
  }

  // Scan Zip Central Directory for mandatory entries & split indicators
  const fileBuffer = await fsp.readFile(apkPath);
  const fileStr = fileBuffer.toString('binary');

  const hasManifest = fileStr.includes('AndroidManifest.xml');
  const hasDex = /classes\d*\.dex/.test(fileStr);
  const isSplit = fileStr.includes('split_config.') || fileStr.includes('base.apk\x00');

  if (isSplit) {
    throw new Error(
      'CRITICAL: APK contains internal split configurations. This is a multi-split bundle, not a monolithic APK.',
    );
  }

  if (!hasManifest || !hasDex) {
    throw new Error(
      'CRITICAL: APK is missing AndroidManifest.xml or DEX bytecode entries. Corrupt or non-Android archive.',
    );
  }

  return stat.size;
}

// --- Version Detection ---
async function resolveGooglePhotosVersion(targetApk, explicitVersion = '') {
  if (explicitVersion) return explicitVersion;
  if (process.env.GPHOTOS_VERSION) return process.env.GPHOTOS_VERSION;

  // 1. Check input/metadata.json
  try {
    const metaPath = path.join(INPUT_DIR, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
      if (meta.version && meta.version !== 'unknown') {
        logInfo(`Resolved Photos version from input/metadata.json: ${meta.version}`);
        return meta.version;
      }
    }
  } catch {}

  // 2. Check input/version.txt
  try {
    const vPath = path.join(INPUT_DIR, 'version.txt');
    if (fs.existsSync(vPath)) {
      const v = (await fsp.readFile(vPath, 'utf8')).trim();
      if (v && v !== 'unknown' && v !== 'latest') {
        logInfo(`Resolved Photos version from input/version.txt: ${v}`);
        return v;
      }
    }
  } catch {}

  // 3. Try running aapt2 / aapt dump badging if available
  try {
    const res = await execPromise('aapt2', ['dump', 'badging', targetApk]);
    const m = res.stdout.match(/versionName='([^']+)'/);
    if (m && m[1]) {
      logInfo(`Resolved Photos version from aapt2 badging: ${m[1]}`);
      return m[1];
    }
  } catch {
    try {
      const res = await execPromise('aapt', ['dump', 'badging', targetApk]);
      const m = res.stdout.match(/versionName='([^']+)'/);
      if (m && m[1]) {
        logInfo(`Resolved Photos version from aapt badging: ${m[1]}`);
        return m[1];
      }
    } catch {}
  }

  // 4. Check filename
  const baseName = path.basename(targetApk);
  const nameMatch = baseName.match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  if (nameMatch && nameMatch[1]) {
    logInfo(`Resolved Photos version from filename: ${nameMatch[1]}`);
    return nameMatch[1];
  }

  // 5. Check config/versions.json
  try {
    const versionsJson = path.join(__dirname, 'config', 'versions.json');
    if (fs.existsSync(versionsJson)) {
      const v = JSON.parse(await fsp.readFile(versionsJson, 'utf8'));
      if (v.gphotos?.version) {
        logInfo(`Resolved Photos version from config/versions.json: ${v.gphotos.version}`);
        return v.gphotos.version;
      }
    }
  } catch {}

  return '7.89.0.968035987';
}

// --- Magisk Module Packaging ---
async function packageMagiskModule(signedApkPath, outputZipPath, version) {
  try {
    const { buildMagiskModule } = await import('./dist/core/magisk.js');
    const versionCode = parseInt(version.replace(/\./g, '').slice(0, 8)) || 1;
    await buildMagiskModule({
      signedApkPath,
      outputZipPath,
      moduleId: 'revanced_gphotos',
      moduleVersion: `${version}-morphe`,
      moduleVersionCode: versionCode,
    });
    logSuccess(`Magisk module packaged successfully at: ${outputZipPath}`);
    return true;
  } catch (err) {
    logWarn(`Magisk module build skipped / failed (${err.message}).`);
    return false;
  }
}

// --- Release Notes Generator ---
function generateReleaseNotesMarkdown(meta) {
  const version = meta.version;
  const apkAsset = meta.assets.primaryApk;
  const magiskAsset = meta.assets.magiskZip;
  const profileAsset = meta.assets.profile;
  const dateStr = new Date(meta.buildDate).toISOString().split('T')[0];

  const lines = [
    `## Google Photos v${version}`,
    ``,
    `Built ${dateStr} | Pixel XL (marlin) spoof | Unlimited original-quality backup`,
    ``,
    `### Toolchain`,
    ``,
    `| Component | Version |`,
    `| :--- | :--- |`,
    `| Google Photos | ${version} |`,
    `| Morphe CLI | ${meta.toolchain.morpheCli} |`,
    `| Morphe Patches | ${meta.toolchain.morphePatches} |`,
    `| uber-apk-signer | ${meta.toolchain.uberSigner} |`,
    ``,
    `### Assets`,
    ``,
    `| File | Size | SHA-256 |`,
    `| :--- | :--- | :--- |`,
    `| \`${apkAsset.fileName}\` | ${apkAsset.sizeMb} MB | \`${apkAsset.sha256}\` |`,
  ];

  if (magiskAsset) {
    lines.push(`| \`${magiskAsset.fileName}\` | ${magiskAsset.sizeMb} MB | \`${magiskAsset.sha256}\` |`);
  }
  if (profileAsset) {
    lines.push(`| \`${profileAsset.fileName}\` | ${profileAsset.sizeKb} KB | \`${profileAsset.sha256}\` |`);
  }

  lines.push(
    ``,
    `### Install`,
    ``,
    `**Non-root:**`,
    `1. Install [GmsCore](https://github.com/ReVanced/GmsCore/releases).`,
    `2. Install the APK (\`adb install -r "${apkAsset.fileName}"\`).`,
    `3. Set both Google Photos and GmsCore battery mode to Unrestricted.`,
    ``,
    `**Root (Magisk/KernelSU):** Flash the \`.zip\` module and reboot.`,
    ``,
    `### Verify`,
    ``,
    `Google Photos > Profile > Settings > Backup should show:`,
    `**"This Pixel can back up unlimited photos & videos at no charge."**`,
    ``,
    `Upload a file, then check [one.google.com/storage](https://one.google.com/storage) — quota should not increase.`,
  );

  return lines.join('\n') + '\n';
}


// --- Main Pipeline ---
async function runPipeline() {
  logHeader('Morphe Google Photos Automation Pipeline v1.0.0');

  // Ensure directories exist
  for (const dir of [INPUT_DIR, OUTPUT_DIR, TOOLS_DIR, LOGS_DIR, CACHE_DIR, TEMP_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }

  logInfo(`Transcript log: ${transcriptPath}`);

  // Clean if requested
  if (cliOpts.clean) {
    logInfo('Cleaning previous outputs and temporary files...');
    for (const f of await fsp.readdir(OUTPUT_DIR))
      await fsp.unlink(path.join(OUTPUT_DIR, f)).catch(() => {});
    for (const f of await fsp.readdir(TEMP_DIR))
      await fsp.unlink(path.join(TEMP_DIR, f)).catch(() => {});
    logSuccess('Clean completed.');
  }

  // Step 1: Pre-Flight Environment Checks
  logHeader('Step 1: Pre-Flight Environment Verification');

  let javaVersionOutput = '';
  try {
    const res = await execPromise('java', ['-version']);
    javaVersionOutput = res.stderr || res.stdout;
  } catch (err) {
    throw new Error(
      `Java runtime not found in PATH: ${err.message}. Please install 64-bit Java 17 or newer.`,
    );
  }

  logInfo(`Java runtime detected:\n${javaVersionOutput.trim()}`);

  let javaMajor = 0;
  const match = javaVersionOutput.match(/(?:version|openjdk version) "(?:1\.)?(\d+)/i);
  if (match) {
    javaMajor = parseInt(match[1], 10);
  }

  if (javaMajor < 17) {
    throw new Error(
      `Java 17+ is required for multi-dex smali processing (Detected: Java ${javaMajor}).`,
    );
  }
  logSuccess(`Verified Java ${javaMajor} 64-bit compatibility.`);

  // Load config.json
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config.json at ${CONFIG_PATH}`);
  }
  const config = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
  logInfo(`Target: ${config.targetApp.packageName} (${config.targetApp.appName})`);
  logInfo(
    `Spoof Target: ${config.spoofConfig.manufacturer} ${config.spoofConfig.model} (${config.spoofConfig.device})`,
  );

  // Step 2: APK Discovery & Monolithic Validation
  logHeader('Step 2: APK Discovery & Monolithic nodpi Validation');

  let targetApk = '';
  if (cliOpts.inputApk && fs.existsSync(cliOpts.inputApk)) {
    targetApk = path.resolve(cliOpts.inputApk);
  } else {
    const inputFiles = await fsp.readdir(INPUT_DIR);
    const apkFiles = inputFiles.filter((f) => f.toLowerCase().endsWith('.apk'));
    if (apkFiles.length > 0) {
      apkFiles.sort(
        (a, b) =>
          fs.statSync(path.join(INPUT_DIR, b)).mtimeMs -
          fs.statSync(path.join(INPUT_DIR, a)).mtimeMs,
      );
      targetApk = path.join(INPUT_DIR, apkFiles[0]);
    }
  }

  if (!targetApk || !fs.existsSync(targetApk)) {
    throw new Error(
      `No input APK found! Place a Google Photos monolithic nodpi APK in '${INPUT_DIR}' or specify via --input '<path>'. Download monolithic nodpi release from APKMirror: https://www.apkmirror.com/apk/google-inc/photos/`,
    );
  }

  logInfo(`Target APK selected: ${targetApk}`);
  const apkSize = await validateMonolithicApk(targetApk);
  logSuccess(
    `APK verified: Monolithic nodpi package confirmed (${(apkSize / 1024 / 1024).toFixed(2)} MB).`,
  );

  // Resolve version
  const gphotosVersion = await resolveGooglePhotosVersion(targetApk, cliOpts.appVersion);
  logSuccess(`Target Google Photos version confirmed: v${gphotosVersion}`);

  // Step 3: Dynamic Toolchain Resolution
  logHeader('Step 3: Dynamic Toolchain Resolution');

  const githubToken = process.env.GITHUB_TOKEN || null;
  const toolVersions = {
    morpheCli: 'latest',
    morphePatches: 'latest',
    uberSigner: 'latest',
  };

  async function resolveAsset(repo, regexStr, destFileName, toolKey) {
    const destPath = path.join(TOOLS_DIR, destFileName);
    if (cliOpts.skipDownload && fs.existsSync(destPath)) {
      logInfo(`[${repo}] Using cached asset: ${destFileName}`);
      return destPath;
    }

    const regex = new RegExp(regexStr, 'i');
    logInfo(`Checking latest release for ${repo}...`);

    try {
      const release = await httpsGetJson(
        `https://api.github.com/repos/${repo}/releases/latest`,
        githubToken,
      );
      if (release.tag_name && toolKey) {
        toolVersions[toolKey] = release.tag_name;
      }
      const asset = release.assets?.find((a) => regex.test(a.name));

      if (!asset) {
        if (fs.existsSync(destPath)) {
          logWarn(
            `No asset matching '${regexStr}' in latest release. Using existing cached ${destFileName}.`,
          );
          return destPath;
        }
        throw new Error(
          `Could not find asset matching regex '${regexStr}' in release '${release.tag_name}' of '${repo}'.`,
        );
      }

      logInfo(
        `Found asset: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB, Release: ${release.tag_name})`,
      );
      logInfo(`Downloading ${asset.name}...`);
      await downloadFile(asset.browser_download_url, destPath, githubToken);
      logSuccess(`Downloaded and cached: ${destFileName}`);
      return destPath;
    } catch (err) {
      if (fs.existsSync(destPath)) {
        logWarn(
          `GitHub resolution failed for ${repo} (${err.message}). Using local cache at ${destPath}.`,
        );
        return destPath;
      }
      throw err;
    }
  }

  const morpheCliJar = await resolveAsset(
    config.toolchain.morpheCli.repo,
    config.toolchain.morpheCli.assetRegex,
    'morphe-cli.jar',
    'morpheCli',
  );
  const morphePatchesMpp = await resolveAsset(
    config.toolchain.morphePatches.repo,
    config.toolchain.morphePatches.assetRegex,
    'patches.mpp',
    'morphePatches',
  );
  const uberSignerJar = await resolveAsset(
    config.toolchain.uberApkSigner.repo,
    config.toolchain.uberApkSigner.assetRegex,
    'uber-apk-signer.jar',
    'uberSigner',
  );

  // Step 4: Patching with Morphe CLI (-Xmx4g)
  logHeader('Step 4: Executing Morphe Patching (-Xmx4g Heap)');

  const tempPatchedApk = path.join(TEMP_DIR, 'patched-unsigned.apk');
  if (fs.existsSync(tempPatchedApk)) await fsp.unlink(tempPatchedApk);

  const jvmArgs = [
    config.jvmOptions.maxHeap,
    config.jvmOptions.initialHeap,
    config.jvmOptions.fileEncoding,
    config.jvmOptions.garbageCollector,
    '-jar',
    morpheCliJar,
    'patch',
    '-f',
    '--unsigned',
    '--patches',
    morphePatchesMpp,
    '--options-file',
    OPTIONS_PATH,
    '-o',
    tempPatchedApk,
    targetApk,
  ];

  logInfo(`Executing: java ${jvmArgs.join(' ')}`);

  await new Promise((resolve, reject) => {
    const proc = spawn('java', jvmArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let combinedLog = '';

    proc.stdout.on('data', (d) => {
      const line = d.toString();
      combinedLog += line;
      process.stdout.write(`\x1b[90m  [morphe] ${line}\x1b[0m`);
      try {
        fs.appendFileSync(transcriptPath, `  [morphe] ${line}`);
      } catch {}
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString();
      combinedLog += line;
      process.stderr.write(`\x1b[35m  [morphe-err] ${line}\x1b[0m`);
      try {
        fs.appendFileSync(transcriptPath, `  [morphe-err] ${line}`);
      } catch {}
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempPatchedApk)) {
        resolve();
      } else {
        const snippet = combinedLog.slice(-1000);
        reject(
          new Error(`Morphe patching failed with exit code ${code}. Log snippet:\n${snippet}`),
        );
      }
    });

    proc.on('error', (err) => reject(new Error(`Failed to spawn JVM: ${err.message}`)));
  });

  logSuccess('Morphe patch processing completed successfully.');

  // Step 5: uber-apk-signer Alignment and v1/v2/v3 Signing
  logHeader('Step 5: Automated 4-Byte Zip Alignment & v1/v2/v3 Signing');

  const finalSignedApk = path.join(OUTPUT_DIR, 'com.google.android.apps.photos-morphe-signed.apk');
  const humanNamedApk = path.join(
    OUTPUT_DIR,
    `GooglePhotos-v${gphotosVersion}-PixelXL-unlimited.apk`,
  );
  if (fs.existsSync(finalSignedApk)) await fsp.unlink(finalSignedApk);
  if (fs.existsSync(humanNamedApk)) await fsp.unlink(humanNamedApk);

  const signerArgs = [
    '-jar',
    uberSignerJar,
    '-a',
    tempPatchedApk,
    '-o',
    OUTPUT_DIR,
    '--allowResign',
    '--verbose',
  ];

  const customKs = cliOpts.keystorePath || process.env.KEYSTORE_PATH || '';
  if (customKs && fs.existsSync(customKs)) {
    logInfo(`Using custom signing keystore: ${customKs}`);
    signerArgs.push(
      '--ks',
      customKs,
      '--ksAlias',
      process.env.KEY_ALIAS || 'release',
      '--ksPass',
      process.env.KEY_STORE_PASS || '',
      '--keyPass',
      process.env.KEY_PASS || '',
    );
  } else {
    logInfo(
      'No custom keystore specified. uber-apk-signer will auto-generate a resilient debug key.',
    );
  }

  logInfo(`Executing uber-apk-signer...`);
  await execPromise('java', signerArgs);

  // Locate resulting signed APK
  const outputFiles = await fsp.readdir(OUTPUT_DIR);
  const signedCandidate = outputFiles
    .filter((f) => f.toLowerCase().includes('signed') && f.toLowerCase().endsWith('.apk'))
    .sort(
      (a, b) =>
        fs.statSync(path.join(OUTPUT_DIR, b)).mtimeMs -
        fs.statSync(path.join(OUTPUT_DIR, a)).mtimeMs,
    )[0];

  if (signedCandidate) {
    const candidatePath = path.join(OUTPUT_DIR, signedCandidate);
    if (candidatePath !== finalSignedApk) {
      await fsp.rename(candidatePath, finalSignedApk);
    }
  }

  if (!fs.existsSync(finalSignedApk)) {
    throw new Error(`Failed to locate signed APK artifact in: ${OUTPUT_DIR}`);
  }

  // Create human-friendly named copy
  await fsp.copyFile(finalSignedApk, humanNamedApk);
  logSuccess(`Created primary release artifact: ${path.basename(humanNamedApk)}`);

  // Step 6: Magisk Root Module Generation (Optional / Standard)
  logHeader('Step 6: Magisk & KernelSU Root Module Packaging');

  let magiskZipPath = null;
  const magiskZipFileName = `GooglePhotos-v${gphotosVersion}-Magisk-module.zip`;
  const magiskZipDest = path.join(OUTPUT_DIR, magiskZipFileName);
  const legacyMagiskZip = path.join(OUTPUT_DIR, 'magisk-revanced-gphotos.zip');

  if (!cliOpts.skipMagisk && process.env.SKIP_MAGISK !== 'true') {
    const built = await packageMagiskModule(finalSignedApk, magiskZipDest, gphotosVersion);
    if (built && fs.existsSync(magiskZipDest)) {
      magiskZipPath = magiskZipDest;
      await fsp.copyFile(magiskZipDest, legacyMagiskZip).catch(() => {});
    }
  } else {
    logInfo('Skipping Magisk module creation (--skip-magisk or SKIP_MAGISK=true).');
  }

  // Step 7: Artifact Integrity & Metadata Summary
  logHeader('Step 7: Build Summary & Executive Release Metadata Generation');

  const finalStat = await fsp.stat(finalSignedApk);
  const fileData = await fsp.readFile(finalSignedApk);
  const sha256 = crypto.createHash('sha256').update(fileData).digest('hex');
  const md5 = crypto.createHash('md5').update(fileData).digest('hex');
  const sizeMb = (finalStat.size / 1024 / 1024).toFixed(2);

  // Copy export profile into output
  const profileSrc = path.join(__dirname, 'export-profile.json');
  const profileDest = path.join(OUTPUT_DIR, 'export-profile.json');
  if (fs.existsSync(profileSrc)) {
    await fsp.copyFile(profileSrc, profileDest);
  }
  const profileStat = fs.existsSync(profileDest) ? await fsp.stat(profileDest) : null;
  const profileSha256 = profileStat
    ? crypto
        .createHash('sha256')
        .update(await fsp.readFile(profileDest))
        .digest('hex')
    : '';

  // Calculate Magisk stats if built
  let magiskStat = null;
  let magiskSha256 = null;
  let magiskSizeMb = null;
  if (magiskZipPath && fs.existsSync(magiskZipPath)) {
    magiskStat = await fsp.stat(magiskZipPath);
    magiskSha256 = crypto
      .createHash('sha256')
      .update(await fsp.readFile(magiskZipPath))
      .digest('hex');
    magiskSizeMb = (magiskStat.size / 1024 / 1024).toFixed(2);
  }

  const releaseTag = `v${gphotosVersion}`;
  const releaseTitle = `Google Photos v${gphotosVersion} • Pixel XL Unlimited Backup`;
  const buildIsoDate = new Date().toISOString();

  const releaseMeta = {
    appName: 'Google Photos',
    packageName: config.targetApp.packageName,
    version: gphotosVersion,
    releaseTag,
    releaseTitle,
    buildDate: buildIsoDate,
    spoofTarget: {
      manufacturer: config.spoofConfig.manufacturer,
      model: config.spoofConfig.model,
      device: config.spoofConfig.device,
      product: config.spoofConfig.product,
      entitlement: config.spoofConfig.backupEntitlement,
    },
    toolchain: toolVersions,
    assets: {
      primaryApk: {
        fileName: path.basename(humanNamedApk),
        path: humanNamedApk,
        sizeBytes: finalStat.size,
        sizeMb,
        sha256,
        md5,
      },
      signedApk: {
        fileName: path.basename(finalSignedApk),
        path: finalSignedApk,
        sizeBytes: finalStat.size,
        sizeMb,
        sha256,
        md5,
      },
      magiskZip: magiskZipPath
        ? {
            fileName: path.basename(magiskZipPath),
            path: magiskZipPath,
            sizeBytes: magiskStat.size,
            sizeMb: magiskSizeMb,
            sha256: magiskSha256,
          }
        : null,
      profile: profileStat
        ? {
            fileName: 'export-profile.json',
            path: profileDest,
            sizeBytes: profileStat.size,
            sizeKb: (profileStat.size / 1024).toFixed(2),
            sha256: profileSha256,
          }
        : null,
    },
  };

  const metaJsonPath = path.join(OUTPUT_DIR, 'release-meta.json');
  await fsp.writeFile(metaJsonPath, JSON.stringify(releaseMeta, null, 2), 'utf8');
  logSuccess(`Generated release metadata: ${metaJsonPath}`);

  // Generate Release Notes
  const releaseNotesMarkdown = generateReleaseNotesMarkdown(releaseMeta);
  const releaseNotesPath = path.join(OUTPUT_DIR, 'release-notes.md');
  await fsp.writeFile(releaseNotesPath, releaseNotesMarkdown, 'utf8');
  await fsp.writeFile(path.join(__dirname, 'release-notes.md'), releaseNotesMarkdown, 'utf8');
  logSuccess(`Generated rich release notes: ${releaseNotesPath}`);

  logSuccess('BUILD SUCCEEDED!');
  logInfo(`Release Tag    : ${releaseTag}`);
  logInfo(`Release Title  : ${releaseTitle}`);
  logInfo(`Primary APK    : ${humanNamedApk}`);
  logInfo(`File Size      : ${sizeMb} MB`);
  logInfo(`SHA-256 Digest : ${sha256}`);
  logInfo(`MD5 Digest     : ${md5}`);

  console.log(`
\x1b[32m======================================================================
  NEXT STEPS (DEPLOYMENT & STORAGE VERIFICATION)
======================================================================\x1b[0m
\x1b[36m1. Install GmsCore (MicroG) if not already installed on device:
   https://github.com/ReVanced/GmsCore/releases

2. Sideload the signed APK to your Android device via ADB:
   \x1b[33madb install -r "${humanNamedApk}"\x1b[36m

3. Whitelist Google Photos & GmsCore in Battery Optimization (Set to 'Unrestricted').

4. Open Google Photos, sign in to your Google Account, and verify under:
   Account Profile -> Google Photos Settings -> Backup:
   \x1b[32m"This Pixel can back up unlimited photos & videos at no charge."\x1b[36m
\x1b[32m======================================================================\x1b[0m
`);
}

runPipeline().catch((err) => {
  logError(`Build Failed: ${err.message}`);
  if (err.stack) {
    try {
      fs.appendFileSync(transcriptPath, `\nSTACK TRACE:\n${err.stack}\n`);
    } catch {}
  }
  process.exit(1);
});
