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
  integrationsApkPath?: string | null;  // Optional — removed in CLI v6+
  patchConfig: ResolvedPatchConfig;
}

export async function runPatcher(options: PatcherOptions): Promise<void> {
  const args = [
    '-jar', options.cliJarPath,
    'patch',
    '--patch-bundle', options.patchesJarPath,
    ...(options.integrationsApkPath ? ['--merge', options.integrationsApkPath] : []),
    '--options', options.patchConfig.optionsPath,
    ...options.patchConfig.includeFlags,
    '--out', options.outputApkPath,
    options.inputApkPath,
  ];

  logger.info(`[patcher] Executing java ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn('java', args, { stdio: 'pipe' });
    let stderrContent = '';

    child.stdout.on('data', (data) => {
      process.stdout.write(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
      stderrContent += data.toString();
      if (stderrContent.length > 5000) {
        stderrContent = stderrContent.substring(stderrContent.length - 5000);
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const snippet = stderrContent.substring(stderrContent.length - 500);
        reject(new PatchError(`Patcher exited with code ${code}. Stderr snippet: ${snippet}`));
      } else {
        resolve();
      }
    });

    child.on('error', (err) => {
      reject(new PatchError(`Failed to spawn java: ${err.message}`));
    });
  });
}
