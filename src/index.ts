import fs from 'fs/promises';
import fsSync from 'fs';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import path from 'path';
import { CONFIG } from './config.js';
import { logger } from './utils/logger.js';
import { fetchLatestReVancedRelease } from './api/github.js';
import { downloadFile } from './core/downloader.js';
import { verifySha256 } from './core/verifier.js';
import { fetchGPhotosApk } from './core/apkFetcher.js';
import { buildPatchConfig } from './core/patchConfig.js';
import { runPatcher } from './core/patcher.js';
import { repackForDirectMmap } from './core/apkRepack.js';
import { signApk } from './core/signer.js';
import { buildMagiskModule } from './core/magisk.js';
import { recolorLauncherIcons } from './core/iconRecolor.js';

async function calculateFileSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const readStream = fsSync.createReadStream(filePath);
  await pipeline(readStream, hash);
  return hash.digest('hex');
}

async function writeReleaseMeta(data: any): Promise<void> {
  const metaPath = CONFIG.paths.releaseMeta;
  await fs.writeFile(metaPath, JSON.stringify(data.meta, null, 2));

  const notesPath = CONFIG.paths.releaseNotes;
  let notes = `## Google Photos ReVanced \n\n`;
  notes += `* **Google Photos Version:** ${data.meta.gphotosVersion} (via ${data.source})\n`;
  notes += `* **ReVanced CLI:** ${data.meta.revancedCliVersion}\n`;
  notes += `* **ReVanced Patches:** ${data.meta.revancedPatchesVersion}\n`;
  notes += `* **ReVanced Integrations:** ${data.meta.revancedIntegrationsVersion}\n\n`;

  notes += `### Applied Patches\n`;
  for (const p of data.meta.appliedPatches) {
    notes += `- \`${p}\`\n`;
  }
  notes += `\n### Device Spoof Target\n`;
  notes += `* **Model:** ${CONFIG.spoofTarget.model} (${CONFIG.spoofTarget.product})\n\n`;

  notes += `### Hashes (SHA-256)\n`;
  notes += `- **Signed APK:** \`${data.meta.signedApkSha256}\`\n`;
  if (data.meta.magiskZipSha256) {
    notes += `- **Magisk Zip:** \`${data.meta.magiskZipSha256}\`\n`;
  }

  notes += `\n### Installation\n`;
  notes += `#### Non-Root (Standard)\n`;
  notes += `1. Install [MicroG / GmsCore](https://github.com/ReVanced/GmsCore/releases) first.\n`;
  notes += `2. Install the provided \`.apk\` file.\n\n`;

  notes += `#### Root (Magisk/KernelSU)\n`;
  notes += `1. Flash the provided \`.zip\` module in Magisk/KernelSU.\n`;
  notes += `2. Reboot. Google Photos will be replaced at the system level.\n`;

  await fs.writeFile(notesPath, notes);
}

async function main() {
  try {
    // Step 1 — Prepare workspace
    await fs.mkdir(CONFIG.paths.workspace, { recursive: true });
    await fs.mkdir(CONFIG.paths.toolsDir, { recursive: true });

    // Step 2 — Fetch ReVanced release metadata
    const release = await fetchLatestReVancedRelease(CONFIG.revanced.org, CONFIG.revanced.cliRepo); // Or a specific combined repo, usually patches
    // Wait, the github fetcher fetches all 3 components from their respective repos?
    // Let's refine fetchLatestReVancedRelease to fetch from revanced-patches or individually.
    // Assuming fetchLatestReVancedRelease handles all for now (as implemented)
    logger.info(`[orchestrator] ReVanced release metadata fetched.`);

    const cliPath = path.join(CONFIG.paths.toolsDir, release.cli.name);
    const patchesPath = path.join(CONFIG.paths.toolsDir, release.patches.name);
    const integrationsPath = release.integrations
      ? path.join(CONFIG.paths.toolsDir, release.integrations.name)
      : null;

    // Step 3 — Download ReVanced tools
    await downloadFile(release.cli.downloadUrl, cliPath, 'revanced-cli');
    await downloadFile(release.patches.downloadUrl, patchesPath, 'revanced-patches');
    if (release.integrations && integrationsPath) {
      await downloadFile(
        release.integrations.downloadUrl,
        integrationsPath,
        'revanced-integrations',
      );
    }

    // Step 4 — Verify checksums. sha256 may be null for the v5 API fallback (no hash published).
    const skipReason = (label: string) =>
      `[orchestrator] No SHA-256 published for ${label}; skipping pre-download verification (asset trusted via TLS to official source)`;

    if (release.cli.sha256) await verifySha256(cliPath, release.cli.sha256);
    else logger.warn(skipReason(release.cli.name));

    if (release.patches.sha256) await verifySha256(patchesPath, release.patches.sha256);
    else logger.warn(skipReason(release.patches.name));

    if (release.integrations && integrationsPath) {
      if (release.integrations.sha256)
        await verifySha256(integrationsPath, release.integrations.sha256);
      else logger.warn(skipReason(release.integrations.name));
    }
    logger.info('[orchestrator] Tool checksum verification step complete');

    // Step 5 — Fetch base APK
    const apkResult = await fetchGPhotosApk(CONFIG.paths.inputApk);
    logger.info(`[orchestrator] Google Photos ${apkResult.version} downloaded`);

    // Step 5b — Recolor icons before patching so the CLI's zipalign cleans up any shift.
    if (process.env[CONFIG.envKeys.skipIconRecolor] === 'true') {
      logger.info('[orchestrator] SKIP_ICON_RECOLOR=true — keeping stock launcher icon colors');
    } else {
      try {
        const recolorResult = await recolorLauncherIcons(CONFIG.paths.inputApk);
        logger.info(
          `[orchestrator] Icon recolor: ${recolorResult.recolored} recolored, ${recolorResult.skipped} skipped, ${recolorResult.scanned} scanned`,
        );
      } catch (err: any) {
        logger.warn(
          `[orchestrator] Icon recolor failed (continuing with stock icons): ${err?.message || err}`,
        );
      }
    }

    // Step 6 — Build patch configuration
    const patchConfig = await buildPatchConfig(cliPath, patchesPath);
    logger.info(
      `[orchestrator] Patch config built: ${patchConfig.appliedPatches.map((p: any) => p.name).join(', ')}`,
    );

    // Step 7 — Patch
    await runPatcher({
      inputApkPath: CONFIG.paths.inputApk,
      outputApkPath: CONFIG.paths.patchedApk,
      cliJarPath: cliPath,
      patchesJarPath: patchesPath,
      integrationsApkPath: integrationsPath,
      patchConfig,
    });
    logger.info('[orchestrator] Patching complete');

    // Step 7b — Re-pack for direct mmap
    await repackForDirectMmap({
      inputApkPath: CONFIG.paths.patchedApk,
      outputApkPath: CONFIG.paths.repackedApk,
    });
    logger.info('[orchestrator] Re-pack complete');

    // Step 8 — Sign
    await signApk(CONFIG.paths.repackedApk, CONFIG.paths.signedApk);
    logger.info('[orchestrator] Signing complete');

    // Calculate signed apk hash
    const signedApkSha256 = await calculateFileSha256(CONFIG.paths.signedApk);
    let magiskZipSha256: string | null = null;

    // Step 9 — Magisk module (optional)
    if (process.env[CONFIG.envKeys.skipMagisk] !== 'true') {
      await buildMagiskModule({
        signedApkPath: CONFIG.paths.signedApk,
        outputZipPath: CONFIG.paths.magiskZip,
        moduleId: 'revanced_gphotos',
        moduleVersion: `${apkResult.version}-rv`,
        moduleVersionCode: parseInt(apkResult.version.replace(/\./g, '')) || 1,
      });
      logger.info('[orchestrator] Magisk module built');
      try {
        magiskZipSha256 = await calculateFileSha256(CONFIG.paths.magiskZip);
      } catch {
        // ignore
      }
    }

    // Step 10 — Write release metadata
    const metaDate = new Date();
    const releaseTag = `revanced-gphotos-${apkResult.version}-rv${metaDate.toISOString().split('T')[0]}`;
    await writeReleaseMeta({
      source: apkResult.source,
      meta: {
        releaseTag,
        buildTimestamp: metaDate.toISOString(),
        gphotosVersion: apkResult.version,
        revancedCliVersion: release.cli.name,
        revancedPatchesVersion: release.patches.name,
        revancedIntegrationsVersion: release.integrations?.name ?? 'n/a (CLI v6+)',
        appliedPatches: patchConfig.appliedPatches.map((p: any) => p.name),
        signedApkSha256,
        magiskZipSha256,
      },
    });
    logger.info('[orchestrator] Pipeline complete');
  } catch (err: any) {
    logger.error('[orchestrator] Pipeline failed', err);
    process.exit(1);
  }
}

void main();
