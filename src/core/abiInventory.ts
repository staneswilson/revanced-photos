import AdmZip from 'adm-zip';
import { logger } from '../utils/logger.js';

export function inventoryAbis(apkPath: string): string[] {
  const zip = new AdmZip(apkPath);
  const abis = new Set<string>();
  for (const entry of zip.getEntries()) {
    const match = entry.entryName.match(/^lib\/([^/]+)\//);
    if (match) abis.add(match[1]!);
  }
  return Array.from(abis).sort();
}

export function logAbiInventory(apkPath: string, label: string): string[] {
  let abis: string[];
  try {
    abis = inventoryAbis(apkPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[abiInventory] Could not inspect ${label} at ${apkPath}: ${msg}`);
    return [];
  }
  logger.info(`[abiInventory] ${label} → ABIs: ${abis.length > 0 ? abis.join(', ') : '(none)'}`);
  if (!abis.includes('arm64-v8a')) {
    logger.warn(
      `[abiInventory] ${label} contains no arm64-v8a native libs. Modern 64-bit-only Android ` +
        `devices (Pixel 7+, recent flagships) will refuse install with "App not compatible". ` +
        `APKPure may not host an arm64 variant for the resolved Photos version — try pinning ` +
        `GPHOTOS_VERSION to an older release. See SETUP.md troubleshooting.`,
    );
  }
  return abis;
}
