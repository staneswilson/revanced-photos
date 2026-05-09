import { execFile as execFileOriginal } from 'child_process';
import path from 'path';
import fs from 'fs/promises';

const execFileAsync = (cmd: string, args: string[], options?: any) => new Promise<{stdout: string, stderr: string}>((resolve, reject) => {
  execFileOriginal(cmd, args, options || {}, (err, stdout, stderr) => {
    if (err) {
      (err as any).stdout = stdout;
      (err as any).stderr = stderr;
      return reject(err instanceof Error ? err : new Error((err as any).message || 'Unknown Error'));
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config.js';

export class ApkFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkFetchError';
  }
}

export interface ApkFetchResult {
  version: string;
  source: 'apkpure' | 'google-play';
  outputPath: string;
}

/**
 * Queries apkeep for the version listing of the configured package and
 * returns the latest 4-segment version. apkeep prints the listing in
 * oldest→newest order on a single comma-separated line, so the last match is
 * the most recent. Returns null on any failure (caller decides how to react).
 */
async function resolveLatestVersion(listingDir: string): Promise<string | null> {
  logger.info(`[apkFetcher] No version pin set; querying APKPure for latest...`);
  try {
    const { stdout } = await execFileAsync('apkeep', [
      '-l',
      '-a', CONFIG.packageName,
      '-d', 'apk-pure',
      listingDir,
    ]);
    const matches = stdout.match(/\d+\.\d+\.\d+\.\d+/g);
    if (!matches || matches.length === 0) {
      logger.warn(`[apkFetcher] Could not parse version listing: ${stdout.substring(0, 300)}`);
      return null;
    }
    const latest = matches[matches.length - 1]!;
    logger.info(`[apkFetcher] Latest APKPure version: ${latest}`);
    return latest;
  } catch (err: any) {
    logger.warn(`[apkFetcher] apkeep -l failed: ${err?.message || err}`);
    return null;
  }
}

export async function fetchGPhotosApk(outputPath: string): Promise<ApkFetchResult> {
  let versionPin = process.env[CONFIG.envKeys.gphotosVersion];

  if (!versionPin) {
    try {
      const versionsJsonPath = path.resolve(process.cwd(), 'config', 'versions.json');
      const versionsData = await fs.readFile(versionsJsonPath, 'utf-8');
      const parsed = JSON.parse(versionsData);
      versionPin = parsed.gphotos?.version;
      if (versionPin) {
        logger.info(`[apkFetcher] Using pinned version ${versionPin} from versions.json`);
      }
    } catch {
      // Ignored if file doesn't exist
    }
  } else {
    logger.info(`[apkFetcher] Using pinned version ${versionPin} from env var`);
  }

  const outDir = path.dirname(outputPath);

  // No pin → resolve the current latest before downloading so the version is
  // known to the rest of the pipeline (release tag, meta.json, notes).
  if (!versionPin) {
    versionPin = (await resolveLatestVersion(outDir)) ?? undefined;
  }

  const packageNameArg = versionPin ? `${CONFIG.packageName}@${versionPin}` : CONFIG.packageName;

  const args = [
    '-a', packageNameArg,
    '-d', 'apk-pure',
    outDir,
  ];

  logger.info(`[apkFetcher] Running apkeep with args: ${args.join(' ')}`);

  try {
    // apkeep must be in PATH
    const { stdout, stderr } = await execFileAsync('apkeep', args);

    // Prefer the explicit pin: the stdout regex `[0-9.]+` would truncate a
    // 4-segment version (e.g. `7.75.0.911466973`) to the 3-segment marketing
    // form if apkeep prints that variant.
    let version = versionPin || 'unknown';
    if (!versionPin) {
      const match = stdout.match(/Downloading .*? ([0-9.]+)/i);
      if (match && match[1]) {
        version = match[1];
      } else {
        logger.warn(`[apkFetcher] Could not parse version from apkeep stdout: ${stdout.substring(0, 200)}`);
        if (stderr) logger.warn(`[apkFetcher] apkeep stderr: ${stderr.substring(0, 500)}`);
      }
    }

    // apkeep's output layout has changed across versions: older builds wrote
    // "<package>.apk" flat in outDir, newer ones write "<package>@<ver>.apk"
    // or nest the file inside a "<package>/" subdirectory. Scan recursively.
    const allEntries = (await fs.readdir(outDir, { recursive: true })) as string[];
    const apkCandidates = allEntries.filter((rel) => {
      const base = path.basename(rel);
      return base.startsWith(CONFIG.packageName) && base.toLowerCase().endsWith('.apk');
    });
    if (apkCandidates.length === 0) {
      const xapk = allEntries.find((rel) =>
        path.basename(rel).startsWith(CONFIG.packageName) &&
        path.basename(rel).toLowerCase().endsWith('.xapk'),
      );
      if (xapk) {
        throw new ApkFetchError(
          `apkeep produced an XAPK (${xapk}) — split-APK bundles are not supported by this pipeline`,
        );
      }
      // apkeep 0.17.0 silently exits 0 with empty stdout/stderr when the
      // pinned version doesn't exist on APKPure. Surface that hypothesis.
      const hint = versionPin
        ? `\nLikely cause: pinned version "${versionPin}" does not exist on APKPure. Run \`apkeep -l -a ${CONFIG.packageName} -d apk-pure <outdir>\` to list available versions.`
        : '';
      throw new ApkFetchError(
        `apkeep produced no APK matching "${CONFIG.packageName}*.apk" under ${outDir}. Tree: ${allEntries.join(', ') || '(empty)'}.${hint}`,
      );
    }
    if (apkCandidates.length > 1) {
      throw new ApkFetchError(
        `apkeep produced multiple APKs (${apkCandidates.join(', ')}); split-APK handling is not implemented`,
      );
    }
    const downloadedFile = path.join(outDir, apkCandidates[0]!);
    await fs.rename(downloadedFile, outputPath);

    return {
      version,
      source: 'apkpure',
      outputPath,
    };
  } catch (error: any) {
    const stderrContent = error.stderr ? error.stderr.substring(error.stderr.length - 500) : String(error);
    throw new ApkFetchError(`apkeep failed: ${stderrContent}`);
  }
}
