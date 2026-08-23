import { execFile as execFileOriginal } from 'child_process';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs/promises';

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
import { logger } from '../utils/logger.js';
import { secureWipe } from '../utils/fs.js';
import { CONFIG } from '../config.js';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export async function signApk(inputApkPath: string, outputApkPath: string): Promise<void> {
  const b64 = process.env[CONFIG.envKeys.keystoreB64];
  const alias = process.env[CONFIG.envKeys.keyAlias];
  const storePass = process.env[CONFIG.envKeys.keyStorePass];
  const keyPass = process.env[CONFIG.envKeys.keyPass];

  const missing: string[] = [];
  if (!b64) missing.push(CONFIG.envKeys.keystoreB64);
  if (!alias) missing.push(CONFIG.envKeys.keyAlias);
  if (!storePass) missing.push(CONFIG.envKeys.keyStorePass);
  if (!keyPass) missing.push(CONFIG.envKeys.keyPass);

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing required environment variables for signing: ${missing.join(', ')}`,
    );
  }

  const keystoreBuffer = Buffer.from(b64!, 'base64');
  const tempPath = path.join(os.tmpdir(), `keystore-${crypto.randomUUID()}.jks`);

  let wipeError: any = null;
  try {
    await fs.writeFile(tempPath, keystoreBuffer, { mode: 0o600 });
    logger.info(`[signer] Decoded keystore to temporary secure path`);

    logger.info(`[signer] Signing APK...`);
    await execFileAsync('apksigner', [
      'sign',
      '--ks',
      tempPath,
      '--ks-key-alias',
      alias!,
      '--ks-pass',
      `pass:${storePass}`,
      '--key-pass',
      `pass:${keyPass}`,
      '--out',
      outputApkPath,
      inputApkPath,
    ]);

    logger.info(`[signer] Verifying APK signature...`);
    const { stdout } = await execFileAsync('apksigner', [
      'verify',
      '--print-certs',
      '-v',
      outputApkPath,
    ]);

    if (!stdout.includes('Verified using v')) {
      throw new Error(`Signature verification failed. Output: ${stdout}`);
    }

    const certMatch = stdout.match(/Signer #1 certificate DN: (.*)/);
    if (certMatch) {
      logger.info(`[signer] Certificate DN: ${certMatch[1]}`);
    }
  } finally {
    try {
      await secureWipe(tempPath);
    } catch (e) {
      logger.error(`[signer] CRITICAL: Failed to wipe temporary keystore!`, e);
      wipeError = e;
    }
  }

  if (wipeError) throw wipeError;
}
