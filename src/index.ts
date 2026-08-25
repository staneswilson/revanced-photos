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
import { fetchGPhotosApk, resolveAvailableVersions, ApkFetchResult } from './core/apkFetcher.js';
import { buildPatchConfig } from './core/patchConfig.js';
import { runPatcher } from './core/patcher.js';
import { repackForDirectMmap } from './core/apkRepack.js';
import { signApk } from './core/signer.js';
import { buildMagiskModule } from './core/magisk.js';
import { recolorLauncherIcons } from './core/iconRecolor.js';

async function applyIconRecolorIfEnabled(apkPath: string): Promise<void> {
  if (process.env[CONFIG.envKeys.skipIconRecolor] === 'true') {
    logger.info('[orchestrator] SKIP_ICON_RECOLOR=true — keeping stock launcher icon colors');
    return;
  }
  try {
    const recolorResult = await recolorLauncherIcons(apkPath);
    logger.info(
      `[orchestrator] Icon recolor: ${recolorResult.recolored} recolored, ${recolorResult.skipped} skipped, ${recolorResult.scanned} scanned`,
    );
  } catch (err: any) {
    logger.warn(
      `[orchestrator] Icon recolor failed (continuing with stock icons): ${err?.message || err}`,
    );
  }
}

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
  const lines: string[] = [
    `## Google Photos ReVanced — ${data.meta.gphotosVersion}`,
    ``,
    `| Component | Version |`,
    `| :--- | :--- |`,
    `| Google Photos | ${data.meta.gphotosVersion} (${data.source}) |`,
    `| ReVanced CLI | ${data.meta.revancedCliVersion} |`,
    `| ReVanced Patches | ${data.meta.revancedPatchesVersion} |`,
    `| ReVanced Integrations | ${data.meta.revancedIntegrationsVersion} |`,
    `| Spoof Target | ${CONFIG.spoofTarget.model} (${CONFIG.spoofTarget.product}) |`,
    ``,
    `### Applied Patches`,
    ``,
    ...data.meta.appliedPatches.map((p: string) => `- \`${p}\``),
    ``,
    `### SHA-256`,
    ``,
    `- Signed APK: \`${data.meta.signedApkSha256}\``,
  ];

  if (data.meta.magiskZipSha256) {
    lines.push(`- Magisk module: \`${data.meta.magiskZipSha256}\``);
  }

  lines.push(
    ``,
    `### Install`,
    ``,
    `**Non-root:** Install [GmsCore](https://github.com/ReVanced/GmsCore/releases), then install the APK.`,
    ``,
    `**Root (Magisk/KernelSU):** Flash the \`.zip\` module and reboot.`,
  );

  await fs.writeFile(notesPath, lines.join('\n') + '\n');
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

    // Step 5 — Build patch configuration
    const patchConfig = await buildPatchConfig(cliPath, patchesPath);
    logger.info(
      `[orchestrator] Patch config built: ${patchConfig.appliedPatches.map((p: any) => p.name).join(', ')}`,
    );

    let explicitPin = process.env[CONFIG.envKeys.gphotosVersion];
    if (!explicitPin) {
      try {
        const versionsJsonPath = path.resolve(process.cwd(), 'config', 'versions.json');
        const versionsData = await fs.readFile(versionsJsonPath, 'utf-8');
        const parsed = JSON.parse(versionsData);
        explicitPin = parsed.gphotos?.version || undefined;
      } catch {
        // Ignored if file doesn't exist
      }
    }

    let apkResult: ApkFetchResult | null = null;

    if (explicitPin) {
      logger.info(`[orchestrator] Using explicit version pin: ${explicitPin}`);
      apkResult = await fetchGPhotosApk(CONFIG.paths.inputApk, explicitPin);
      logger.info(`[orchestrator] Google Photos ${apkResult.version} downloaded`);
      await applyIconRecolorIfEnabled(CONFIG.paths.inputApk);

      await runPatcher({
        inputApkPath: CONFIG.paths.inputApk,
        outputApkPath: CONFIG.paths.patchedApk,
        cliJarPath: cliPath,
        patchesJarPath: patchesPath,
        integrationsApkPath: integrationsPath,
        patchConfig,
      });
      logger.info('[orchestrator] Patching complete');
    } else {
      // Auto-resolve mode: Try candidate versions starting from the newest
      const workspaceDir = path.dirname(CONFIG.paths.inputApk);
      const candidates = await resolveAvailableVersions(workspaceDir);
      if (candidates.length === 0) {
        const initial = await fetchGPhotosApk(CONFIG.paths.inputApk);
        candidates.push(initial.version);
      }

      logger.info(
        `[orchestrator] Auto-resolving newest compatible version among ${candidates.length} candidate(s)...`,
      );

      let success = false;
      let lastError: Error | null = null;

      for (const candidate of candidates) {
        logger.info(`[orchestrator] Testing candidate release: ${candidate}`);
        try {
          await fs.unlink(CONFIG.paths.inputApk).catch(() => {});
          await fs.unlink(CONFIG.paths.patchedApk).catch(() => {});

          const fetched = await fetchGPhotosApk(CONFIG.paths.inputApk, candidate);
          logger.info(`[orchestrator] Google Photos ${fetched.version} downloaded`);
          await applyIconRecolorIfEnabled(CONFIG.paths.inputApk);

          await runPatcher({
            inputApkPath: CONFIG.paths.inputApk,
            outputApkPath: CONFIG.paths.patchedApk,
            cliJarPath: cliPath,
            patchesJarPath: patchesPath,
            integrationsApkPath: integrationsPath,
            patchConfig,
          });

          apkResult = fetched;
          success = true;
          logger.info(`[orchestrator] Successfully patched Google Photos ${apkResult.version}!`);
          break;
        } catch (err: any) {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn(
            `[orchestrator] Candidate ${candidate} is not compatible with current ReVanced patches (${lastError.message}). Falling back to next newest release...`,
          );
        }
      }

      if (!success || !apkResult) {
        throw new Error(
          `[orchestrator] Failed to find a compatible Google Photos release. Last error: ${lastError?.message}`,
        );
      }
    }

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
