import { describe, it, expect, vi } from 'vitest';
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
  }
}));

describe('apkFetcher', () => {
  it('should call execFile with correct apkeep args and parse version', async () => {
    const result = await fetchGPhotosApk('/tmp/input.apk');
    expect(child_process.execFile).toHaveBeenCalledWith(
      'apkeep',
      ['-a', 'com.google.android.apps.photos', '-d', 'apk-pure', '/tmp'],
      expect.any(Object),
      expect.any(Function)
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
      expect.any(Function)
    );
    delete process.env.GPHOTOS_VERSION;
  });

  it('should throw ApkFetchError when apkeep fails', async () => {
    // We can't easily mock the command args to trigger error with the current mock setup unless we change it.
    // Let's redefine mock just for this test
    vi.mocked(child_process.execFile).mockImplementationOnce((cmd, args, options, callback: any) => {
      callback({ stderr: 'Mock apkeep error output' }, '', 'Mock apkeep error output');
    });

    await expect(fetchGPhotosApk('/tmp/input.apk')).rejects.toThrowError(ApkFetchError);
  });
});
