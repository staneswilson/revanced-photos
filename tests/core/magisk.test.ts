import { describe, it, expect, vi } from 'vitest';
import { buildMagiskModule } from '../../src/core/magisk.js';
import fs from 'fs/promises';
import { CONFIG } from '../../src/config.js';

// Mock archiver completely to avoid file system operations
vi.mock('archiver', () => {
  return {
    default: vi.fn(() => ({
      on: vi.fn(),
      pipe: vi.fn(),
      directory: vi.fn(),
      finalize: vi.fn().mockImplementation(function(this: any) {
        // Emit 'close' on the mocked write stream manually if possible, or just wait.
        // We'll mock the createWriteStream returning an object that emits close.
      }),
    })),
  };
});

import { EventEmitter } from 'events';

vi.mock('fs', () => ({
  default: {
    createWriteStream: vi.fn(() => {
      const stream = new EventEmitter();
      setTimeout(() => stream.emit('close'), 10);
      return stream;
    }),
  }
}));

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    copyFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  }
}));

describe('magisk', () => {
  it('should generate module.prop and zip successfully', async () => {
    process.env[CONFIG.envKeys.skipMagisk] = 'false';

    await buildMagiskModule({
      signedApkPath: 'signed.apk',
      outputZipPath: 'magisk.zip',
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('module.prop'),
      expect.stringContaining('id=test_module\nname=ReVanced Google Photos')
    );

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('update-binary'),
      expect.stringContaining('SKIPUNZIP=1\n'),
      { mode: 0o755 }
    );
  });

  it('should return early if SKIP_MAGISK is true', async () => {
    process.env[CONFIG.envKeys.skipMagisk] = 'true';
    await buildMagiskModule({
      signedApkPath: 'signed.apk',
      outputZipPath: 'magisk.zip',
      moduleId: 'test_module',
      moduleVersion: '1.0',
      moduleVersionCode: 1,
    });
    // Shouldn't do anything else
  });
});
