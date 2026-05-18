import { execFile as execFileOriginal } from 'child_process';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config.js';
import { logAbiInventory } from './abiInventory.js';

const execFileAsync = (cmd: string, args: string[], options?: any) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFileOriginal(cmd, args, options || {}, (err, stdout, stderr) => {
      if (err) {
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        return reject(
          err instanceof Error ? err : new Error((err as any).message || 'Unknown Error'),
        );
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

export class XapkMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XapkMergeError';
  }
}

export async function mergeXapkToApk(xapkPath: string, outputApkPath: string): Promise<void> {
  const jarPath = process.env[CONFIG.envKeys.apkeditorJar];
  if (!jarPath) {
    throw new XapkMergeError(
      `${CONFIG.envKeys.apkeditorJar} env var is not set. Photos now ships as a split-APK ` +
        `bundle (XAPK) on APKPure, so the pipeline needs APKEditor to merge the splits into ` +
        `a single universal APK before patching. Download the jar from ` +
        `https://github.com/REAndroid/APKEditor/releases and set ${CONFIG.envKeys.apkeditorJar} ` +
        `to its absolute path.`,
    );
  }

  const args = ['-jar', jarPath, 'm', '-i', xapkPath, '-o', outputApkPath, '-f'];
  logger.info(`[xapkMerge] Merging splits: java ${args.join(' ')}`);

  try {
    const { stdout, stderr } = await execFileAsync('java', args, {
      maxBuffer: 1024 * 1024 * 10,
    });
    if (stdout.trim()) logger.info(`[xapkMerge] APKEditor stdout: ${stdout.trim().slice(-500)}`);
    if (stderr.trim()) logger.info(`[xapkMerge] APKEditor stderr: ${stderr.trim().slice(-500)}`);
    logger.info(`[xapkMerge] Wrote merged APK to ${outputApkPath}`);
    logAbiInventory(outputApkPath, 'merged APK');
  } catch (error: any) {
    const stderrSnippet = error?.stderr
      ? String(error.stderr).slice(-800)
      : error?.message || String(error);
    throw new XapkMergeError(`APKEditor merge failed: ${stderrSnippet}`);
  }
}
