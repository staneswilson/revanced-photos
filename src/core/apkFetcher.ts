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

  const packageNameArg = versionPin ? `${CONFIG.packageName}@${versionPin}` : CONFIG.packageName;
  const outDir = path.dirname(outputPath);

  const args = [
    '-a', packageNameArg,
    '-d', 'apkpure',
    outDir,
  ];

  logger.info(`[apkFetcher] Running apkeep with args: ${args.join(' ')}`);

  try {
    // apkeep must be in PATH
    const { stdout } = await execFileAsync('apkeep', args);

    const match = stdout.match(/Downloading .*? ([0-9.]+)/i);
    let version = versionPin || 'unknown';
    if (match && match[1]) {
      version = match[1];
    } else {
      logger.warn(`[apkFetcher] Could not parse version from apkeep stdout: ${stdout.substring(0, 200)}`);
    }

    const downloadedFile = path.join(outDir, `${CONFIG.packageName}.apk`);
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
