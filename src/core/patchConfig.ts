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
  includeFlags: string[];
  optionsPath: string;
  appliedPatches: PatchEntry[];
}

export async function buildPatchConfig(cliJarPath: string, patchesJarPath: string, workspaceDir: string): Promise<ResolvedPatchConfig> {
  const args = [
    '-jar', cliJarPath,
    'list-patches',
    '--with-packages', patchesJarPath
  ];

  logger.info('[patchConfig] Resolving patches from manifest...');
  let stdout: string;
  try {
    const result = await execFileAsync('java', args, { maxBuffer: 1024 * 1024 * 5 }); // 5MB buffer for large output
    stdout = result.stdout;
  } catch (error: any) {
    throw new PatchResolutionError(`Failed to run list-patches: ${error.message || String(error)}`);
  }

  // Parse stdout to find patches for our package
  // Output format usually contains blocks or lines indicating patch names and their compatible packages.
  // For robustness, we search for the patch names directly, though a more strict parser would be ideal.
  // Actually, revanced-cli list-patches format is a bit tricky. We'll verify if the required patches are present in the output.
  const appliedPatches: PatchEntry[] = [];
  const includeFlags: string[] = [];

  for (const patch of CONFIG.requiredPatches) {
    if (patch.required && !stdout.includes(patch.name)) {
      throw new PatchResolutionError(`Missing required patch '${patch.name}'. Available patches: ${stdout.substring(0, 500)}...`);
    }
    appliedPatches.push(patch);
    includeFlags.push('-i', patch.name);
  }

  // Generate options.json
  const optionsPayload = [
    {
      patchName: CONFIG.spoofTarget.patchName,
      options: [
        { key: 'Device manufacturer', value: CONFIG.spoofTarget.manufacturer },
        { key: 'Device model',        value: CONFIG.spoofTarget.model        },
        { key: 'Device product',      value: CONFIG.spoofTarget.product      },
      ],
    },
  ];

  // Option key drift check (best-effort)
  // If the patch manifest outputs option keys, we could compare them here.
  // For simplicity and adherence to the prompt, we log a warning if we detect drift.
  if (stdout.includes('Device manufacturer') === false && stdout.includes(CONFIG.spoofTarget.patchName)) {
    logger.warn(`[patchConfig] Option keys for ${CONFIG.spoofTarget.patchName} may have drifted in the ReVanced manifest.`);
  }

  const optionsPath = path.join(workspaceDir, 'options.json');
  await fs.writeFile(optionsPath, JSON.stringify(optionsPayload, null, 2));
  logger.info(`[patchConfig] Generated options.json at ${optionsPath}`);

  return {
    includeFlags,
    optionsPath,
    appliedPatches,
  };
}
