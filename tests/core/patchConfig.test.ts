import { describe, it, expect, vi } from 'vitest';
import { buildPatchConfig, PatchResolutionError } from '../../src/core/patchConfig.js';
import * as child_process from 'child_process';
import fs from 'fs/promises';
import path from 'path';

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    const stdout = `
INFO: spoof-features [com.google.android.apps.photos]
INFO: gmscore-support [com.google.android.apps.photos]
    `;
    callback(null, stdout, '');
  }),
}));

vi.mock('fs/promises', () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
  }
}));

describe('patchConfig', () => {
  it('should resolve required patches and generate options.json', async () => {
    const config = await buildPatchConfig('cli.jar', 'patches.jar', '/workspace');
    
    expect(config.includeFlags).toEqual(['-i', 'spoof-features', '-i', 'gmscore-support']);
    expect(config.appliedPatches.length).toBe(2);
    expect(config.optionsPath).toBe(path.join('/workspace', 'options.json'));
    expect(fs.writeFile).toHaveBeenCalledWith(
      config.optionsPath,
      expect.stringContaining('Device manufacturer')
    );
  });

  it('should throw PatchResolutionError when a required patch is absent', async () => {
    vi.mocked(child_process.execFile).mockImplementationOnce((cmd, args, options, callback: any) => {
      callback(null, 'INFO: other-patch [com.google.android.youtube]', '');
    });

    await expect(buildPatchConfig('cli.jar', 'patches.jar', '/workspace')).rejects.toThrowError(PatchResolutionError);
  });
});
