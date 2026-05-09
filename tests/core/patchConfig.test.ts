import { describe, it, expect, vi } from 'vitest';
import { buildPatchConfig, PatchResolutionError } from '../../src/core/patchConfig.js';
import * as child_process from 'child_process';

// Mock ReVanced CLI v6 `list-patches` output. Each patch is rendered as a
// multi-line block with `Name: <patch>` on its own line — that's what the
// resolver matches against.
const v6ListPatchesOutput = `INFO: Index: 47
Name: Spoof features
Description: Spoofs the device to enable Google Pixel exclusive features.
Enabled: true
Compatible packages:
\tPackage name: com.google.android.apps.photos

Index: 48
Name: GmsCore support
Description: Allows the app to work without root using a different package name.
Enabled: true
Compatible packages:
\tPackage name: com.google.android.apps.photos
`;

vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, options, callback) => {
    callback(null, v6ListPatchesOutput, '');
  }),
}));

describe('patchConfig', () => {
  it('should resolve required v6 patches and emit -e enable flags', async () => {
    const config = await buildPatchConfig('cli.jar', 'patches.rvp', '/workspace');

    expect(config.enableFlags).toEqual(['-e', 'Spoof features', '-e', 'GmsCore support']);
    expect(config.appliedPatches.map((p) => p.name)).toEqual(['Spoof features', 'GmsCore support']);
  });

  it('should invoke list-patches with v6 syntax (-p, -b, --filter-package-name)', async () => {
    await buildPatchConfig('cli.jar', 'patches.rvp', '/workspace');
    expect(child_process.execFile).toHaveBeenCalledWith(
      'java',
      [
        '-jar', 'cli.jar',
        'list-patches',
        '-p', 'patches.rvp',
        '-b',
        '--filter-package-name=com.google.android.apps.photos',
        '--packages',
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should throw PatchResolutionError when a required patch is absent', async () => {
    vi.mocked(child_process.execFile).mockImplementationOnce((cmd, args, options, callback: any) => {
      callback(null, 'Index: 0\nName: Some unrelated patch\n', '');
    });

    await expect(buildPatchConfig('cli.jar', 'patches.rvp', '/workspace')).rejects.toThrowError(PatchResolutionError);
  });
});
