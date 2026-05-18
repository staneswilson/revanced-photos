import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { inventoryAbis } from '../../src/core/abiInventory.js';

describe('abiInventory', () => {
  let tempApkPath: string;

  beforeEach(() => {
    tempApkPath = path.join(
      os.tmpdir(),
      `abi-test-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`,
    );
  });

  afterEach(async () => {
    try {
      await fs.unlink(tempApkPath);
    } catch {
      // already gone
    }
  });

  it('extracts distinct ABI directories from lib/*/', () => {
    const zip = new AdmZip();
    zip.addFile('lib/arm64-v8a/libfoo.so', Buffer.from('x'));
    zip.addFile('lib/arm64-v8a/libbar.so', Buffer.from('y'));
    zip.addFile('lib/armeabi-v7a/libfoo.so', Buffer.from('z'));
    zip.addFile('AndroidManifest.xml', Buffer.from('placeholder'));
    zip.writeZip(tempApkPath);

    expect(inventoryAbis(tempApkPath)).toEqual(['arm64-v8a', 'armeabi-v7a']);
  });

  it('returns an empty list when the APK has no lib/ entries', () => {
    const zip = new AdmZip();
    zip.addFile('AndroidManifest.xml', Buffer.from('placeholder'));
    zip.addFile('res/values/strings.xml', Buffer.from('<resources/>'));
    zip.writeZip(tempApkPath);

    expect(inventoryAbis(tempApkPath)).toEqual([]);
  });
});
