import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import archiver from 'archiver';
import AdmZip from 'adm-zip';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config.js';

export interface MagiskModuleOptions {
  signedApkPath: string;
  outputZipPath: string;
  moduleId: string;
  moduleVersion: string;
  moduleVersionCode: number;
}

async function extractNativeLibs(
  apkPath: string,
  systemAppDir: string,
): Promise<{ abis: string[]; totalLibs: number }> {
  const zip = new AdmZip(apkPath);
  const abis = new Set<string>();
  let totalLibs = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const match = entry.entryName.match(/^lib\/([^/]+)\/(.+\.so)$/);
    if (!match) continue;

    const [, abi, soName] = match;
    abis.add(abi!);
    const destDir = path.join(systemAppDir, 'lib', abi!);
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, soName!), entry.getData());
    totalLibs += 1;
  }

  return { abis: Array.from(abis).sort(), totalLibs };
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

    const updateBinaryContent = `#!/sbin/sh
SKIPUNZIP=1
unzip -o "$ZIPFILE" 'system/*' -d "$MODPATH"
set_perm_recursive "$MODPATH/system/priv-app/Photos" root root 0755 0644
if [ -d "$MODPATH/system/priv-app/Photos/lib" ]; then
  find "$MODPATH/system/priv-app/Photos/lib" -name '*.so' -exec chmod 0755 {} \\;
fi
`;
    await fs.writeFile(path.join(metaInfDir, 'update-binary'), updateBinaryContent, {
      mode: 0o755,
    });

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

    const apkDestPath = path.join(systemAppDir, 'Photos.apk');
    await fs.copyFile(options.signedApkPath, apkDestPath);

    const { abis, totalLibs } = await extractNativeLibs(options.signedApkPath, systemAppDir);
    if (totalLibs === 0) {
      logger.warn(
        '[magisk] Signed APK contains no lib/<abi>/*.so entries. If Photos crashes ' +
          'with UnsatisfiedLinkError, the APK source is missing native code for the ' +
          "target device's ABI.",
      );
    } else {
      logger.info(
        `[magisk] Extracted ${totalLibs} native lib(s) into system/priv-app/Photos/lib/ ` +
          `for ABIs: ${abis.join(', ')}`,
      );
    }

    // Zip
    logger.info(`[magisk] Creating Magisk zip archive at ${options.outputZipPath}`);
    await new Promise<void>((resolve, reject) => {
      const output = fsSync.createWriteStream(options.outputZipPath);
      const archive = archiver('zip', {
        zlib: { level: 0 }, // Critical: Do not compress APK
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
