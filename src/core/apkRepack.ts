import { execFile as execFileOriginal } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { logger } from '../utils/logger.js';
import { logAbiInventory } from './abiInventory.js';
import { inspectExtractNativeLibs, setExtractNativeLibsFalse } from '../utils/axml.js';

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

const ZIPALIGN_ENV = 'ZIPALIGN_PATH';

function shouldStoreUncompressed(entryName: string): boolean {
  if (/^lib\/[^/]+\/.+\.so$/.test(entryName)) return true;
  if (entryName === 'resources.arsc') return true;
  return false;
}

export async function repackForDirectMmap(options: RepackOptions): Promise<void> {
  const inputZip = new AdmZip(options.inputApkPath);
  const entries = inputZip.getEntries();

  const manifestEntry = entries.find((e) => e.entryName === 'AndroidManifest.xml');
  if (!manifestEntry) {
    throw new ApkRepackError(`AndroidManifest.xml not found in ${options.inputApkPath}`);
  }
  const originalManifest = manifestEntry.getData();

  let newManifest: Buffer;
  try {
    const inspection = inspectExtractNativeLibs(originalManifest);
    if (inspection.hasExtractNativeLibs && inspection.extractNativeLibsValue === false) {
      logger.info('[apkRepack] AndroidManifest already has extractNativeLibs="false"');
      newManifest = originalManifest;
    } else {
      newManifest = setExtractNativeLibsFalse(originalManifest);
      logger.info(
        `[apkRepack] Patched AndroidManifest extractNativeLibs="false" (${originalManifest.length} → ${newManifest.length} bytes)`,
      );
    }
  } catch (error: any) {
    throw new ApkRepackError(
      `Failed to edit AndroidManifest.xml: ${error?.message ?? String(error)}`,
    );
  }

  const tmpDir = path.join(os.tmpdir(), `apkrepack-${crypto.randomUUID()}`);
  const unalignedPath = path.join(tmpDir, 'unaligned.apk');
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    await writeRepackedZip(entries, manifestEntry, newManifest, unalignedPath);
    logger.info(`[apkRepack] Wrote unaligned APK to ${unalignedPath}`);

    await runZipalign(unalignedPath, options.outputApkPath);
    logger.info(`[apkRepack] zipaligned to ${options.outputApkPath}`);

    logAbiInventory(options.outputApkPath, 're-packed APK');
    verifyNativeLibsStored(options.outputApkPath);

    const finalManifest = new AdmZip(options.outputApkPath)
      .getEntries()
      .find((e) => e.entryName === 'AndroidManifest.xml');
    if (finalManifest) {
      const finalInspection = inspectExtractNativeLibs(finalManifest.getData());
      if (
        !finalInspection.hasExtractNativeLibs ||
        finalInspection.extractNativeLibsValue !== false
      ) {
        throw new ApkRepackError(
          `Re-packed APK manifest does not report extractNativeLibs="false" (has=${finalInspection.hasExtractNativeLibs}, value=${finalInspection.extractNativeLibsValue})`,
        );
      }
      logger.info('[apkRepack] Verified extractNativeLibs="false" in re-packed manifest');
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function writeRepackedZip(
  entries: AdmZip.IZipEntry[],
  manifestEntry: AdmZip.IZipEntry,
  newManifest: Buffer,
  outputPath: string,
): Promise<void> {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const output = fsSync.createWriteStream(outputPath);
  const closed = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') logger.warn(`[apkRepack] archiver warning: ${err.message}`);
      else reject(err);
    });
  });
  archive.pipe(output);

  let storedCount = 0;
  let deflatedCount = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.entryName.startsWith('META-INF/')) continue;

    const data = entry === manifestEntry ? newManifest : entry.getData();
    const store = shouldStoreUncompressed(entry.entryName);
    if (store) storedCount++;
    else deflatedCount++;
    archive.append(data, { name: entry.entryName, store });
  }

  await archive.finalize();
  await closed;
  logger.info(`[apkRepack] Re-packed ${storedCount} STORED + ${deflatedCount} DEFLATE entries`);
}

async function runZipalign(inputPath: string, outputPath: string): Promise<void> {
  const zipalignPath = process.env[ZIPALIGN_ENV] || 'zipalign';
  const args = ['-p', '-f', '4', inputPath, outputPath];
  logger.info(`[apkRepack] Running: ${zipalignPath} ${args.join(' ')}`);
  try {
    const { stdout, stderr } = await execFileAsync(zipalignPath, args, {
      maxBuffer: 1024 * 1024 * 16,
    });
    if (stdout.trim()) logger.info(`[apkRepack] zipalign stdout: ${stdout.trim().slice(-500)}`);
    if (stderr.trim()) logger.info(`[apkRepack] zipalign stderr: ${stderr.trim().slice(-500)}`);
  } catch (error: any) {
    const snippet = error?.stderr
      ? String(error.stderr).slice(-800)
      : error?.message || String(error);
    throw new ApkRepackError(
      `zipalign failed (cmd: ${zipalignPath}): ${snippet}. Install Android build-tools and ensure ` +
        `'zipalign' is on PATH, or set ${ZIPALIGN_ENV} to its absolute path.`,
    );
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
    throw new ApkRepackError(
      `${offenders.length}/${total} native libs are still compressed: ${sample}. ` +
        `Direct mmap will fail at runtime.`,
    );
  }
  logger.info(`[apkRepack] All ${total} native libs are STORED (method=0) — direct mmap ready`);
}
