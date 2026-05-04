import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import archiver from 'archiver';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config.js';

export interface MagiskModuleOptions {
  signedApkPath: string;
  outputZipPath: string;
  moduleId: string;
  moduleVersion: string;
  moduleVersionCode: number;
}

export async function buildMagiskModule(options: MagiskModuleOptions): Promise<void> {
  if (process.env[CONFIG.envKeys.skipMagisk] === 'true') {
    logger.warn('[magisk] SKIP_MAGISK is true, skipping Magisk module generation.');
    return;
  }

  const tmpDir = path.join(os.tmpdir(), `magisk-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const metaInfDir = path.join(tmpDir, 'META-INF', 'com', 'google', 'android');
    const systemAppDir = path.join(tmpDir, 'system', 'priv-app', 'Photos');
    
    await fs.mkdir(metaInfDir, { recursive: true });
    await fs.mkdir(systemAppDir, { recursive: true });

    // update-binary script
    const updateBinaryContent = `#!/sbin/sh
SKIPUNZIP=1
unzip -o "$ZIPFILE" 'system/*' -d "$MODPATH"
set_perm_recursive "$MODPATH/system/priv-app/Photos" root root 0644 0644
`;
    await fs.writeFile(path.join(metaInfDir, 'update-binary'), updateBinaryContent, { mode: 0o755 });

    // empty updater-script
    await fs.writeFile(path.join(metaInfDir, 'updater-script'), '');

    // module.prop
    const modulePropContent = `id=${options.moduleId}
name=ReVanced Google Photos (Pixel XL spoof)
version=v${options.moduleVersion}
versionCode=${options.moduleVersionCode}
author=automated-pipeline
description=Google Photos patched with ReVanced. Spoofs Pixel XL (marlin) for unlimited original-quality backups.
updateJson=
`;
    await fs.writeFile(path.join(tmpDir, 'module.prop'), modulePropContent);

    // copy APK
    const apkDestPath = path.join(systemAppDir, 'Photos.apk');
    await fs.copyFile(options.signedApkPath, apkDestPath);

    // Zip
    logger.info(`[magisk] Creating Magisk zip archive at ${options.outputZipPath}`);
    await new Promise<void>((resolve, reject) => {
      const output = fsSync.createWriteStream(options.outputZipPath);
      const archive = archiver('zip', {
        zlib: { level: 0 } // Critical: Do not compress APK
      });

      output.on('close', () => resolve());
      archive.on('error', (err) => reject(err));

      archive.pipe(output);
      archive.directory(tmpDir, false);
      void archive.finalize();
    });

    logger.info('[magisk] Magisk module built successfully');
  } finally {
    // cleanup temp dir
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
