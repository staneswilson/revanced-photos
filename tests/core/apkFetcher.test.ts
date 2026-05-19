import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGPhotosApk, ApkFetchError } from '../../src/core/apkFetcher.js';
import * as child_process from 'child_process';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    if (args.includes('error-trigger')) {
      callback({ stderr: 'Mock apkeep error output' }, '', 'Mock apkeep error output');
      return;
    }
    callback(null, 'Downloading com.google.android.apps.photos 6.91.0\nSuccess', '');
  }),
}));

// We also need to mock fs/promises rename to not actually rename files
vi.mock('fs/promises', () => ({
  default: {
    rename: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error('no versions.json')),
    readdir: vi.fn().mockResolvedValue(['com.google.android.apps.photos@6.91.0.apk']),
  },
}));

describe('apkFetcher', () => {
  beforeEach(() => {
    // Reset call history between tests so toHaveBeenNthCalledWith uses
    // per-test indices, not absolute indices across the suite.
    vi.mocked(child_process.execFile).mockClear();
    // Force the legacy APKPure path; APKMirror (the new default) reaches the
    // network unless explicitly disabled. The dedicated APKMirror tests live
    // in apkmirrorFetcher.test.ts and stub global fetch directly.
    process.env.APK_SOURCE = 'apkpure';
  });

  afterEach(() => {
    delete process.env.APK_SOURCE;
  });

  it('should call execFile with correct apkeep args and parse version', async () => {
    const result = await fetchGPhotosApk('/tmp/input.apk');
    expect(child_process.execFile).toHaveBeenCalledWith(
      'apkeep',
      ['-a', 'com.google.android.apps.photos', '-d', 'apk-pure', '/tmp'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.version).toBe('6.91.0');
    expect(result.outputPath).toBe('/tmp/input.apk');
  });

  it('should append version pin when GPHOTOS_VERSION is set', async () => {
    process.env.GPHOTOS_VERSION = '6.90.0';
    await fetchGPhotosApk('/tmp/input2.apk');
    expect(child_process.execFile).toHaveBeenCalledWith(
      'apkeep',
      ['-a', 'com.google.android.apps.photos@6.90.0', '-d', 'apk-pure', '/tmp'],
      expect.any(Object),
      expect.any(Function),
    );
    delete process.env.GPHOTOS_VERSION;
  });

  it('should resolve latest version via apkeep -l and use it as the pin when none is set', async () => {
    // First call = listing (run because no env var and no versions.json),
    // second call = actual download with the resolved pin.
    vi.mocked(child_process.execFile)
      .mockImplementationOnce((cmd, args, options, callback: any) => {
        callback(
          null,
          'Versions available for com.google.android.apps.photos on APKPure:\n| 5.78.0.428376309, 7.21.0.737764319, 7.75.0.911466973\n',
          '',
        );
      })
      .mockImplementationOnce((cmd, args, options, callback: any) => {
        callback(null, 'Downloading com.google.android.apps.photos 7.75.0.911466973\nSuccess', '');
      });

    const result = await fetchGPhotosApk('/tmp/input3.apk');

    expect(child_process.execFile).toHaveBeenNthCalledWith(
      1,
      'apkeep',
      ['-l', '-a', 'com.google.android.apps.photos', '-d', 'apk-pure', '/tmp'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(child_process.execFile).toHaveBeenNthCalledWith(
      2,
      'apkeep',
      ['-a', 'com.google.android.apps.photos@7.75.0.911466973', '-d', 'apk-pure', '/tmp'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(result.version).toBe('7.75.0.911466973');
  });

  it('should throw ApkFetchError when apkeep fails', async () => {
    // Set GPHOTOS_VERSION so we skip the listing step; then the queued error
    // impl is consumed by the actual download call.
    process.env.GPHOTOS_VERSION = '7.75.0.911466973';
    vi.mocked(child_process.execFile).mockImplementationOnce(
      (cmd, args, options, callback: any) => {
        callback({ stderr: 'Mock apkeep error output' }, '', 'Mock apkeep error output');
      },
    );

    try {
      await expect(fetchGPhotosApk('/tmp/input.apk')).rejects.toThrowError(ApkFetchError);
    } finally {
      delete process.env.GPHOTOS_VERSION;
    }
  });
});
