import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  repackForDirectMmap,
  ApkRepackError,
  verifyNativeLibsStored,
} from '../../src/core/apkRepack.js';
import * as child_process from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    callback(null, 'OK', '');
  }),
}));

describe('apkRepack', () => {
  beforeEach(() => {
    vi.mocked(child_process.execFile).mockClear();
    vi.mocked(child_process.execFile).mockImplementation((cmd, args, options, callback: any) => {
      callback(null, 'OK', '');
    });
  });

  afterEach(() => {
    delete process.env.APKEDITOR_JAR;
  });

  it('throws ApkRepackError with a helpful message when APKEDITOR_JAR is unset', async () => {
    delete process.env.APKEDITOR_JAR;
    await expect(
      repackForDirectMmap({
        inputApkPath: '/tmp/patched.apk',
        outputApkPath: '/tmp/repacked.apk',
      }),
    ).rejects.toThrowError(ApkRepackError);
  });

  it('invokes APKEditor decode then build with -extractNativeLibs false', async () => {
    process.env.APKEDITOR_JAR = '/opt/APKEditor.jar';

    const tmpOut = path.join(os.tmpdir(), `apkrepack-out-${Date.now()}.apk`);
    vi.mocked(child_process.execFile).mockImplementation(
      (cmd: any, args: any, options: any, callback: any) => {
        const argv: string[] = args;
        if (argv.includes('b')) {
          const out = argv[argv.indexOf('-o') + 1]!;
          const zip = new AdmZip();
          zip.addFile('AndroidManifest.xml', Buffer.from('axml'));
          zip.writeZip(out);
        }
        callback(null, 'OK', '');
      },
    );

    await repackForDirectMmap({
      inputApkPath: '/tmp/patched.apk',
      outputApkPath: tmpOut,
    });

    const calls = vi.mocked(child_process.execFile).mock.calls;
    expect(calls.length).toBe(2);

    const decodeArgs = calls[0]![1] as string[];
    expect(decodeArgs).toContain('d');
    expect(decodeArgs).toContain('-i');
    expect(decodeArgs).toContain('/tmp/patched.apk');
    expect(decodeArgs).toContain('-t');
    const decodeTypeIdx = decodeArgs.indexOf('-t');
    expect(decodeArgs[decodeTypeIdx + 1]).toBe('xml');
    expect(decodeArgs).toContain('-f');

    const buildArgs = calls[1]![1] as string[];
    expect(buildArgs).toContain('b');
    expect(buildArgs).toContain('-extractNativeLibs');
    const flagIdx = buildArgs.indexOf('-extractNativeLibs');
    expect(buildArgs[flagIdx + 1]).toBe('false');
    const buildTypeIdx = buildArgs.indexOf('-t');
    expect(buildArgs[buildTypeIdx + 1]).toBe('xml');
    expect(buildArgs).toContain('-o');
    expect(buildArgs[buildArgs.indexOf('-o') + 1]).toBe(tmpOut);

    await fs.rm(tmpOut, { force: true });
  });

  it('wraps APKEditor decode failures in ApkRepackError', async () => {
    process.env.APKEDITOR_JAR = '/opt/APKEditor.jar';
    vi.mocked(child_process.execFile).mockImplementationOnce(
      (cmd: any, args: any, options: any, callback: any) => {
        const err: any = new Error('Process exited with code 1');
        err.stderr = 'java.lang.RuntimeException: bad zip';
        callback(err, '', err.stderr);
      },
    );

    await expect(
      repackForDirectMmap({
        inputApkPath: '/tmp/patched.apk',
        outputApkPath: '/tmp/repacked.apk',
      }),
    ).rejects.toThrowError(/decode failed.*bad zip/);
  });

  it('wraps APKEditor build failures in ApkRepackError', async () => {
    process.env.APKEDITOR_JAR = '/opt/APKEditor.jar';
    let call = 0;
    vi.mocked(child_process.execFile).mockImplementation(
      (cmd: any, args: any, options: any, callback: any) => {
        call += 1;
        if (call === 1) return callback(null, 'OK', '');
        const err: any = new Error('Process exited with code 2');
        err.stderr = 'java.lang.RuntimeException: build broke';
        callback(err, '', err.stderr);
      },
    );

    await expect(
      repackForDirectMmap({
        inputApkPath: '/tmp/patched.apk',
        outputApkPath: '/tmp/repacked.apk',
      }),
    ).rejects.toThrowError(/build failed.*build broke/);
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

  it('does not throw when every native lib is STORED (method=0)', () => {
    const apkPath = path.join(workDir, 'stored.apk');
    const zip = new AdmZip();
    zip.addFile('AndroidManifest.xml', Buffer.from('axml'));
    zip.addFile('lib/arm64-v8a/libnative.so', Buffer.from('elf'.repeat(100)), '', 0);
    zip.addFile('lib/arm64-v8a/libjni.so', Buffer.from('elf'.repeat(100)), '', 0);
    zip.writeZip(apkPath);

    for (const e of new AdmZip(apkPath).getEntries()) {
      if (e.entryName.startsWith('lib/')) {
        (e.header as any).method = 0;
      }
    }

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
});
