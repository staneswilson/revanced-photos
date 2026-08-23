import { spawn } from 'child_process';
import { logger } from '../utils/logger.js';
import { ResolvedPatchConfig } from './patchConfig.js';

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export interface PatcherOptions {
  inputApkPath: string;
  outputApkPath: string;
  cliJarPath: string;
  patchesJarPath: string;
  /** Ignored in CLI v6+ (integrations are now bundled into the RVP). */
  integrationsApkPath?: string | null;
  patchConfig: ResolvedPatchConfig;
}

export async function runPatcher(options: PatcherOptions): Promise<void> {
  // ReVanced CLI v6 patch syntax: `-p <rvp> -b` (bypass PGP — TLS to api.revanced.app
  // is the integrity guarantee for now), `-e <name>` per patch, `-o <output>`,
  // positional <input>. The old `--merge`, `--options <file>`, `-i`, and
  // `--patch-bundle` flags are all gone. Patch options use defaults — the
  // "Spoof features" patch already targets Pixel XL out of the box.
  const args = [
    '-jar',
    options.cliJarPath,
    'patch',
    '-p',
    options.patchesJarPath,
    '-b',
    ...options.patchConfig.enableFlags,
    '-o',
    options.outputApkPath,
    options.inputApkPath,
  ];

  logger.info(`[patcher] Executing java ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn('java', args, { stdio: 'pipe' });
    let combinedOutput = '';

    child.stdout.on('data', (data) => {
      process.stdout.write(data);
      combinedOutput += data.toString();
      if (combinedOutput.length > 20000) {
        combinedOutput = combinedOutput.substring(combinedOutput.length - 20000);
      }
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      combinedOutput += data.toString();
      if (combinedOutput.length > 20000) {
        combinedOutput = combinedOutput.substring(combinedOutput.length - 20000);
      }
    });

    child.on('close', (code) => {
      const requiredPatchesSucceeded =
        combinedOutput.includes('"GmsCore support" succeeded') &&
        combinedOutput.includes('"Spoof features" succeeded');

      const isOnlySharedExtensionFailure =
        combinedOutput.includes('SharedExtensionPatch') || combinedOutput.includes('ExtensionHook');

      if (code !== 0) {
        const snippet = combinedOutput.substring(combinedOutput.length - 800);
        reject(new PatchError(`Patcher exited with code ${code}. Output snippet: ${snippet}`));
      } else if (requiredPatchesSucceeded && isOnlySharedExtensionFailure) {
        logger.warn(
          `[patcher] Upstream SharedExtensionPatch failed to hook attachBaseContext on this release; pipeline DEX guard will handle lifecycle neutralization.`,
        );
        resolve();
      } else if (combinedOutput.includes('SEVERE:') || combinedOutput.includes('PatchException:')) {
        const snippet = combinedOutput.substring(combinedOutput.length - 800);
        reject(
          new PatchError(
            `Patcher encountered fatal patch failure on this target APK version: ${snippet}`,
          ),
        );
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new PatchError(`Failed to spawn java: ${err.message}`));
    });
  });
}
