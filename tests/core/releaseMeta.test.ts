import { describe, it, expect } from 'vitest';

describe('release metadata & markdown formatting', () => {
  it('formats executive release notes with badges, asset tables, and checksums', () => {
    const fakeMeta = {
      appName: 'Google Photos',
      packageName: 'com.google.android.apps.photos',
      version: '7.89.0.968035987',
      releaseTag: 'v7.89.0.968035987',
      releaseTitle: 'Google Photos v7.89.0.968035987 • Pixel XL Unlimited Backup',
      buildDate: '2026-08-25T13:45:00.000Z',
      spoofTarget: {
        manufacturer: 'Google',
        model: 'Pixel XL',
        device: 'marlin',
        product: 'marlin',
        entitlement: 'UNLIMITED_ORIGINAL_QUALITY',
      },
      toolchain: {
        morpheCli: 'v1.0.0',
        morphePatches: 'v0.1.1',
        uberSigner: 'v1.3.0',
      },
      assets: {
        primaryApk: {
          fileName: 'GooglePhotos-v7.89.0.968035987-PixelXL-unlimited.apk',
          sizeBytes: 123456789,
          sizeMb: '117.74',
          sha256: 'abc123sha256',
          md5: 'abc123md5',
        },
        signedApk: {
          fileName: 'com.google.android.apps.photos-morphe-signed.apk',
          sizeBytes: 123456789,
          sizeMb: '117.74',
          sha256: 'abc123sha256',
          md5: 'abc123md5',
        },
        magiskZip: {
          fileName: 'GooglePhotos-v7.89.0.968035987-Magisk-module.zip',
          sizeBytes: 123500000,
          sizeMb: '117.78',
          sha256: 'magisksha256',
        },
        profile: {
          fileName: 'export-profile.json',
          sizeBytes: 1425,
          sizeKb: '1.39',
          sha256: 'profilesha256',
        },
      },
    };

    expect(fakeMeta.releaseTag).toBe('v7.89.0.968035987');
    expect(fakeMeta.releaseTitle).toContain('v7.89.0.968035987');
    expect(fakeMeta.assets.primaryApk.fileName).toBe(
      'GooglePhotos-v7.89.0.968035987-PixelXL-unlimited.apk',
    );
    expect(fakeMeta.assets.magiskZip.fileName).toBe(
      'GooglePhotos-v7.89.0.968035987-Magisk-module.zip',
    );
  });
});
