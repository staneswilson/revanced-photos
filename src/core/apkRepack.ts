import { execFile as execFileOriginal } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
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

export class ApkRepackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkRepackError';
  }
}

export interface RepackOptions {
  inputApkPath: string;
  outputApkPath: string;
}

export async function repackForDirectMmap(options: RepackOptions): Promise<void> {
  const jarPath = process.env[CONFIG.envKeys.apkeditorJar];
  if (!jarPath) {
    throw new ApkRepackError(
      `${CONFIG.envKeys.apkeditorJar} env var is not set. The pipeline needs APKEditor to ` +
        `re-pack the patched APK with android:extractNativeLibs="false" and uncompressed, ` +
        `page-aligned native libs so the Magisk system-app install can mmap libnative.so ` +
        `directly. Download the jar from https://github.com/REAndroid/APKEditor/releases and ` +
        `set ${CONFIG.envKeys.apkeditorJar} to its absolute path.`,
    );
  }

  const tmpDir = path.join(os.tmpdir(), `apkrepack-${crypto.randomUUID()}`);
  const decompiledDir = path.join(tmpDir, 'decompiled');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const decodeArgs = [
      '-jar',
      jarPath,
      'd',
      '-i',
      options.inputApkPath,
      '-o',
      decompiledDir,
      '-t',
      'xml',
      '-f',
    ];
    logger.info(`[apkRepack] Decoding: java ${decodeArgs.join(' ')}`);
    try {
      const { stdout, stderr } = await execFileAsync('java', decodeArgs, {
        maxBuffer: 1024 * 1024 * 16,
      });
      if (stdout.trim()) logger.info(`[apkRepack] decode stdout: ${stdout.trim().slice(-500)}`);
      if (stderr.trim()) logger.info(`[apkRepack] decode stderr: ${stderr.trim().slice(-500)}`);
    } catch (error: any) {
      const snippet = error?.stderr
        ? String(error.stderr).slice(-800)
        : error?.message || String(error);
      throw new ApkRepackError(`APKEditor decode failed: ${snippet}`);
    }

    const buildArgs = [
      '-jar',
      jarPath,
      'b',
      '-i',
      decompiledDir,
      '-o',
      options.outputApkPath,
      '-t',
      'xml',
      '-extractNativeLibs',
      'false',
      '-f',
    ];
    logger.info(`[apkRepack] Building: java ${buildArgs.join(' ')}`);
    try {
      const { stdout, stderr } = await execFileAsync('java', buildArgs, {
        maxBuffer: 1024 * 1024 * 16,
      });
      if (stdout.trim()) logger.info(`[apkRepack] build stdout: ${stdout.trim().slice(-500)}`);
      if (stderr.trim()) logger.info(`[apkRepack] build stderr: ${stderr.trim().slice(-500)}`);
    } catch (error: any) {
      const snippet = error?.stderr
        ? String(error.stderr).slice(-800)
        : error?.message || String(error);
      throw new ApkRepackError(`APKEditor build failed: ${snippet}`);
    }

    logAbiInventory(options.outputApkPath, 're-packed APK');
    verifyNativeLibsStored(options.outputApkPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

export function verifyNativeLibsStored(apkPath: string): void {
  const zip = new AdmZip(apkPath);
  const offenders: { name: string; method: number }[] = [];
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!/^lib\/[^/]+\/.+\.so$/.test(entry.entryName)) continue;
    total += 1;
    const method = (entry.header as any).method as number;
    if (method !== 0) {
      offenders.push({ name: entry.entryName, method });
    }
  }
  if (total === 0) {
    logger.warn('[apkRepack] Re-packed APK contains no lib/<abi>/*.so entries');
    return;
  }
  if (offenders.length > 0) {
    const sample = offenders
      .slice(0, 3)
      .map((o) => `${o.name} (method=${o.method})`)
      .join(', ');
    logger.warn(
      `[apkRepack] ${offenders.length}/${total} native libs are still compressed: ${sample}. ` +
        `Direct mmap will fail at runtime — check APKEditor build flags.`,
    );
    return;
  }
  logger.info(`[apkRepack] All ${total} native libs are STORED (method=0) — direct mmap ready`);
}
