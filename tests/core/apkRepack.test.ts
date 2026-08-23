import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import * as child_process from 'child_process';
import { repackForDirectMmap, verifyNativeLibsStored } from '../../src/core/apkRepack.js';
import { inspectExtractNativeLibs } from '../../src/utils/axml.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    callback(null, 'OK', '');
  }),
}));

const FIXTURE_MANIFEST = path.resolve(__dirname, '..', 'fixtures', 'photos-AndroidManifest.xml');

function buildSyntheticApk(
  apkPath: string,
  manifestBuf: Buffer,
  opts?: { compressedLibs?: boolean },
) {
  const zip = new AdmZip();
  zip.addFile('AndroidManifest.xml', manifestBuf);
  zip.addFile('classes.dex', Buffer.from('dex-stub'.repeat(100)));
  zip.addFile('resources.arsc', Buffer.from('arsc-stub'.repeat(100)));
  zip.addFile('lib/arm64-v8a/libnative.so', Buffer.from('elf-stub-arm64'.repeat(200)));
  zip.addFile('lib/armeabi-v7a/libnative.so', Buffer.from('elf-stub-armv7'.repeat(200)));
  zip.addFile('META-INF/CERT.RSA', Buffer.from('cert-stub'));
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('manifest-stub'));
  zip.writeZip(apkPath);

  if (opts?.compressedLibs) {
    const reread = new AdmZip(apkPath);
    for (const e of reread.getEntries()) {
      if (e.entryName.endsWith('.so')) {
        (e.header as any).method = 8;
      }
    }
  }
}

describe('apkRepack — repackForDirectMmap (pure-JS pipeline)', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repack-test-'));
    vi.mocked(child_process.execFile).mockReset();
    vi.mocked(child_process.execFile).mockImplementation(
      (cmd: any, args: any, options: any, callback: any) => {
        const inputPath = args[args.length - 2];
        const outputPath = args[args.length - 1];
        void fs.copyFile(inputPath, outputPath).then(
          () => callback(null, 'OK', ''),
          (err) => callback(err, '', err.message),
        );
      },
    );
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    delete process.env.ZIPALIGN_PATH;
  });

  it('throws ApkRepackError when AndroidManifest.xml is missing from input', async () => {
    const apkPath = path.join(workDir, 'no-manifest.apk');
    const zip = new AdmZip();
    zip.addFile('classes.dex', Buffer.from('dex'));
    zip.writeZip(apkPath);

    await expect(
      repackForDirectMmap({
        inputApkPath: apkPath,
        outputApkPath: path.join(workDir, 'out.apk'),
      }),
    ).rejects.toThrowError(/AndroidManifest\.xml not found/);
  });

  it('produces a re-packed APK with extractNativeLibs=false in the manifest', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    const manifestBuf = await fs.readFile(FIXTURE_MANIFEST);
    buildSyntheticApk(inputApk, manifestBuf);

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    const outManifest = outZip.getEntries().find((e) => e.entryName === 'AndroidManifest.xml');
    expect(outManifest).toBeDefined();
    const inspection = inspectExtractNativeLibs(outManifest!.getData());
    expect(inspection.hasExtractNativeLibs).toBe(true);
    expect(inspection.extractNativeLibsValue).toBe(false);
  });

  it('STOREs every lib/<abi>/*.so entry and resources.arsc', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    for (const entry of outZip.getEntries()) {
      if (entry.entryName.endsWith('.so') || entry.entryName === 'resources.arsc') {
        expect((entry.header as any).method).toBe(0);
      }
    }
  });

  it('DEFLATEs classes.dex (and other ordinary entries)', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    const dex = outZip.getEntries().find((e) => e.entryName === 'classes.dex');
    expect(dex).toBeDefined();
    expect((dex!.header as any).method).toBe(8);
  });

  it('strips META-INF/* entries from the re-packed APK', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    const metaInf = outZip.getEntries().filter((e) => e.entryName.startsWith('META-INF/'));
    expect(metaInf).toHaveLength(0);
  });

  it('invokes zipalign with -p -f 4 on a temp file then to the requested output path', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const calls = vi.mocked(child_process.execFile).mock.calls;
    expect(calls.length).toBe(1);
    const [cmd, args] = calls[0]!;
    expect(cmd).toBe('zipalign');
    const argv = args as string[];
    expect(argv.slice(0, 3)).toEqual(['-p', '-f', '4']);
    expect(argv[argv.length - 1]).toBe(outputApk);
  });

  it('honors ZIPALIGN_PATH env override', async () => {
    process.env.ZIPALIGN_PATH = '/opt/build-tools/zipalign';
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const [cmd] = vi.mocked(child_process.execFile).mock.calls[0]!;
    expect(cmd).toBe('/opt/build-tools/zipalign');
  });

  it('wraps zipalign failures in ApkRepackError with a hint about PATH/ZIPALIGN_PATH', async () => {
    vi.mocked(child_process.execFile).mockImplementation(
      (cmd: any, args: any, options: any, callback: any) => {
        const err: any = new Error('Process exited with code 1');
        err.stderr = 'zipalign: invalid input file';
        callback(err, '', err.stderr);
      },
    );
    const inputApk = path.join(workDir, 'input.apk');
    buildSyntheticApk(inputApk, await fs.readFile(FIXTURE_MANIFEST));

    await expect(
      repackForDirectMmap({
        inputApkPath: inputApk,
        outputApkPath: path.join(workDir, 'output.apk'),
      }),
    ).rejects.toThrowError(/zipalign failed.*invalid input file/);
  });

  it('skips re-editing when manifest already has extractNativeLibs=false', async () => {
    const inputApk = path.join(workDir, 'input.apk');
    const outputApk = path.join(workDir, 'output.apk');
    const { setExtractNativeLibsFalse } = await import('../../src/utils/axml.js');
    const stockManifest = await fs.readFile(FIXTURE_MANIFEST);
    const preFlagged = setExtractNativeLibsFalse(stockManifest);
    buildSyntheticApk(inputApk, preFlagged);

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    const outManifest = outZip.getEntries().find((e) => e.entryName === 'AndroidManifest.xml');
    const inspection = inspectExtractNativeLibs(outManifest!.getData());
    expect(inspection.hasExtractNativeLibs).toBe(true);
    expect(inspection.extractNativeLibsValue).toBe(false);
    expect(outManifest!.getData().length).toBe(preFlagged.length);
  });

  it('scans and neutralizes GmsCoreSupport checkUpdates in classes.dex during repack', async () => {
    const inputApk = path.join(workDir, 'input-with-dex.apk');
    const outputApk = path.join(workDir, 'output-with-dex.apk');
    const manifestBuf = await fs.readFile(FIXTURE_MANIFEST);

    const zip = new AdmZip();
    zip.addFile('AndroidManifest.xml', manifestBuf);
    zip.addFile('classes.dex', Buffer.from('dummy-dex'));
    zip.writeZip(inputApk);

    await repackForDirectMmap({ inputApkPath: inputApk, outputApkPath: outputApk });

    const outZip = new AdmZip(outputApk);
    const outDex = outZip.getEntries().find((e) => e.entryName === 'classes.dex');
    expect(outDex).toBeDefined();
  });
});

describe('verifyNativeLibsStored', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-libs-'));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('does not throw when every native lib is STORED (method=0)', async () => {
    const apkPath = path.join(workDir, 'stored.apk');
    await new Promise<void>((resolve, reject) => {
      const archive = archiver('zip');
      const out = fsSync.createWriteStream(apkPath);
      out.on('close', () => resolve());
      out.on('error', reject);
      archive.on('error', reject);
      archive.pipe(out);
      archive.append(Buffer.from('axml'), { name: 'AndroidManifest.xml' });
      archive.append(Buffer.from('elf'.repeat(100)), {
        name: 'lib/arm64-v8a/libnative.so',
        store: true,
      });
      archive.append(Buffer.from('elf'.repeat(100)), {
        name: 'lib/arm64-v8a/libjni.so',
        store: true,
      });
      void archive.finalize();
    });

    expect(() => verifyNativeLibsStored(apkPath)).not.toThrow();
  });

  it('does not throw when the APK has no native libs', () => {
    const apkPath = path.join(workDir, 'nolibs.apk');
    const zip = new AdmZip();
    zip.addFile('AndroidManifest.xml', Buffer.from('axml'));
    zip.addFile('classes.dex', Buffer.from('dex'));
    zip.writeZip(apkPath);

    expect(() => verifyNativeLibsStored(apkPath)).not.toThrow();
  });

  it('throws when at least one native lib is DEFLATEd (method != 0)', () => {
    const apkPath = path.join(workDir, 'compressed.apk');
    const zip = new AdmZip();
    zip.addFile('AndroidManifest.xml', Buffer.from('axml'));
    zip.addFile('lib/arm64-v8a/libnative.so', Buffer.from('elf'.repeat(100)));
    zip.writeZip(apkPath);

    expect(() => verifyNativeLibsStored(apkPath)).toThrowError(/still compressed/);
  });
});
