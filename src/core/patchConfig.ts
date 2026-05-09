import { execFile as execFileOriginal } from 'child_process';

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

export class PatchResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchResolutionError';
  }
}

export interface PatchEntry {
  name: string;
  required: boolean;
}

export interface ResolvedPatchConfig {
  /** ReVanced CLI v6 `-e <name>` flags pre-built for the patch invocation. */
  enableFlags: string[];
  appliedPatches: PatchEntry[];
}

export async function buildPatchConfig(cliJarPath: string, patchesJarPath: string, _workspaceDir: string): Promise<ResolvedPatchConfig> {
  // ReVanced CLI v6 `list-patches` syntax: `-p <rvp> -b` (bypass PGP) plus
  // `--filter-package-name` to scope the listing to the target app, which
  // keeps the output to a few hundred lines instead of every patch in the
  // bundle.
  const args = [
    '-jar', cliJarPath,
    'list-patches',
    '-p', patchesJarPath,
    '-b',
    `--filter-package-name=${CONFIG.packageName}`,
    '--packages',
  ];

  logger.info('[patchConfig] Resolving patches from manifest...');
  let stdout: string;
  try {
    const result = await execFileAsync('java', args, { maxBuffer: 1024 * 1024 * 5 });
    stdout = result.stdout;
  } catch (error: any) {
    throw new PatchResolutionError(`Failed to run list-patches: ${error.message || String(error)}`);
  }

  const appliedPatches: PatchEntry[] = [];
  const enableFlags: string[] = [];

  for (const patch of CONFIG.requiredPatches) {
    // CLI v6 prints each patch as `Name: <name>` on its own line.
    const namePattern = new RegExp(`^Name:\\s+${escapeRegex(patch.name)}\\s*$`, 'm');
    if (patch.required && !namePattern.test(stdout)) {
      throw new PatchResolutionError(
        `Missing required patch '${patch.name}' for package ${CONFIG.packageName}. ` +
        `Patch names may have drifted in the latest revanced-patches release. ` +
        `Available patches (truncated):\n${stdout.substring(0, 1500)}`,
      );
    }
    appliedPatches.push(patch);
    enableFlags.push('-e', patch.name);
  }

  logger.info(`[patchConfig] Resolved ${appliedPatches.length} required patches: ${appliedPatches.map((p) => p.name).join(', ')}`);

  return { enableFlags, appliedPatches };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
