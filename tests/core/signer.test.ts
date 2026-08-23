import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signApk, ConfigurationError } from '../../src/core/signer.js';
import * as child_process from 'child_process';
import fs from 'fs/promises';
import { CONFIG } from '../../src/config.js';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    if (args.includes('verify')) {
      callback(null, 'Verified using v2\nSigner #1 certificate DN: CN=Test', '');
    } else {
      callback(null, '', '');
    }
  }),
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
  },
}));

describe('signer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw ConfigurationError when env vars are missing', async () => {
    delete process.env[CONFIG.envKeys.keystoreB64];
    await expect(signApk('in.apk', 'out.apk')).rejects.toThrowError(ConfigurationError);
  });

  it('should sign successfully and wipe temp file unconditionally', async () => {
    process.env[CONFIG.envKeys.keystoreB64] = Buffer.from('test').toString('base64');
    process.env[CONFIG.envKeys.keyAlias] = 'alias';
    process.env[CONFIG.envKeys.keyStorePass] = 'storepass';
    process.env[CONFIG.envKeys.keyPass] = 'keypass';

    await signApk('in.apk', 'out.apk');

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('keystore-'),
      expect.any(Buffer),
      { mode: 0o600 },
    );
    expect(child_process.execFile).toHaveBeenCalledWith(
      'apksigner',
      expect.arrayContaining(['sign', '--ks-key-alias', 'alias']),
      expect.any(Object),
      expect.any(Function),
    );

    // Check if secure wipe was called (random bytes written then unlinked)
    // writeFile is called twice: once to create, once to wipe
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
    expect(fs.unlink).toHaveBeenCalled();
  });

  it('should still wipe the temp file if signing fails', async () => {
    vi.mocked(child_process.execFile).mockImplementationOnce(
      (cmd, args, options, callback: any) => {
        callback(new Error('Signing failed'));
      },
    );

    await expect(signApk('in.apk', 'out.apk')).rejects.toThrowError('Signing failed');

    expect(fs.writeFile).toHaveBeenCalledTimes(2); // still wiped
    expect(fs.unlink).toHaveBeenCalled();
  });
});
