import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { buildMagiskModule } from '../../src/core/magisk.js';
import { CONFIG } from '../../src/config.js';

function makeFakeApk(apkPath: string, libs: Record<string, string[]> = {}): void {
  const zip = new AdmZip();
  zip.addFile('AndroidManifest.xml', Buffer.from('placeholder'));
  zip.addFile('classes.dex', Buffer.from('dex'));
  for (const [abi, sos] of Object.entries(libs)) {
    for (const so of sos) {
      zip.addFile(`lib/${abi}/${so}`, Buffer.from(`elf-${abi}-${so}`));
    }
  }
  zip.writeZip(apkPath);
}

describe('magisk', () => {
  let workDir: string;
  let signedApkPath: string;
  let outputZipPath: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magisk-test-'));
    signedApkPath = path.join(workDir, 'signed.apk');
    outputZipPath = path.join(workDir, 'magisk.zip');
    delete process.env[CONFIG.envKeys.skipMagisk];
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('returns early without writing a zip when SKIP_MAGISK is true', async () => {
    process.env[CONFIG.envKeys.skipMagisk] = 'true';
    makeFakeApk(signedApkPath);

    await buildMagiskModule({
      signedApkPath,
      outputZipPath,
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });

    await expect(fs.access(outputZipPath)).rejects.toThrow();
  });

  it('builds a module containing module.prop, update-binary, and the APK', async () => {
    makeFakeApk(signedApkPath);

    await buildMagiskModule({
      signedApkPath,
      outputZipPath,
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });

    const zip = new AdmZip(outputZipPath);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain('module.prop');
    expect(names).toContain('META-INF/com/google/android/update-binary');
    expect(names).toContain('META-INF/com/google/android/updater-script');
    expect(names).toContain('system/priv-app/Photos/Photos.apk');

    const moduleProp = zip.getEntry('module.prop')!.getData().toString();
    expect(moduleProp).toContain('id=test_module');
    expect(moduleProp).toContain('name=ReVanced Google Photos');

    const updateBinary = zip
      .getEntry('META-INF/com/google/android/update-binary')!
      .getData()
      .toString();
    expect(updateBinary).toContain('SKIPUNZIP=1');
    expect(updateBinary).toContain('set_perm_recursive');
  });

  it('extracts native libs from the APK into system/priv-app/Photos/lib/<abi>/', async () => {
    makeFakeApk(signedApkPath, {
      'arm64-v8a': ['libnative.so', 'libjni.so'],
      'armeabi-v7a': ['libnative.so'],
    });

    await buildMagiskModule({
      signedApkPath,
      outputZipPath,
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });

    const zip = new AdmZip(outputZipPath);
    const names = zip.getEntries().map((e) => e.entryName);

    expect(names).toContain('system/priv-app/Photos/lib/arm64-v8a/libnative.so');
    expect(names).toContain('system/priv-app/Photos/lib/arm64-v8a/libjni.so');
    expect(names).toContain('system/priv-app/Photos/lib/armeabi-v7a/libnative.so');

    const extracted = zip
      .getEntry('system/priv-app/Photos/lib/arm64-v8a/libnative.so')!
      .getData()
      .toString();
    expect(extracted).toBe('elf-arm64-v8a-libnative.so');
  });

  it('builds successfully and logs a warning when the APK has no native libs', async () => {
    makeFakeApk(signedApkPath);

    await buildMagiskModule({
      signedApkPath,
      outputZipPath,
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });

    const zip = new AdmZip(outputZipPath);
    const libEntries = zip
      .getEntries()
      .filter((e) => e.entryName.startsWith('system/priv-app/Photos/lib/'));
    expect(libEntries).toHaveLength(0);
    expect(zip.getEntry('system/priv-app/Photos/Photos.apk')).not.toBeNull();
  });
});
