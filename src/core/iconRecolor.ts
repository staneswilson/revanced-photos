import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

export interface IconRecolorResult {
  scanned: number;
  recolored: number;
  skipped: number;
}

/**
 * Resource paths within the Photos APK whose contents we want to grayscale so
 * the patched app's launcher icon is visually distinct from the stock app.
 * Both `mipmap-*` (modern adaptive icons + their pre-API-26 raster fallbacks)
 * and `drawable-*` (older icon paths and the foreground layer of adaptive
 * icons) are covered. Density qualifiers like `mipmap-xxhdpi-v26` match too.
 */
const ICON_PATTERNS: readonly RegExp[] = [
  /^res\/mipmap-[^/]+\/ic_launcher.*\.(png|webp)$/i,
  /^res\/drawable-[^/]+\/ic_launcher_foreground.*\.(png|webp)$/i,
];

/**
 * Modifies the APK in place: any launcher-icon raster matching ICON_PATTERNS
 * is read, run through sharp's grayscale + format-preserving re-encode, and
 * written back into the same zip entry. Per-entry failures are logged and
 * counted but do not abort the step — a single oddly-encoded resource must
 * not break the build.
 *
 * Recolor is a cosmetic feature; if zero entries match (e.g. Photos shifts
 * its resource layout in a future release) we warn loudly but still succeed.
 * Adaptive icon XML (binary AXML referencing a flat-color background) is not
 * touched in this version — only raster files are recolored.
 */
export async function recolorLauncherIcons(apkPath: string): Promise<IconRecolorResult> {
  const result: IconRecolorResult = { scanned: 0, recolored: 0, skipped: 0 };

  let zip: AdmZip;
  try {
    zip = new AdmZip(apkPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[iconRecolor] Failed to open APK at ${apkPath}: ${msg}`);
  }

  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!ICON_PATTERNS.some((re) => re.test(entry.entryName))) continue;

    result.scanned++;
    try {
      const original = entry.getData();
      // Preserve the input format (PNG → PNG, WebP → WebP) by detecting via
      // sharp's metadata rather than the filename, so we don't mis-encode if
      // an entry has the wrong extension.
      const pipeline = sharp(original).grayscale();
      const meta = await sharp(original).metadata();
      let outputBuffer: Buffer;
      switch (meta.format) {
        case 'png':
          outputBuffer = await pipeline.png().toBuffer();
          break;
        case 'webp':
          outputBuffer = await pipeline.webp().toBuffer();
          break;
        default:
          logger.info(
            `[iconRecolor] Skipping ${entry.entryName}: unsupported sharp format "${meta.format}"`,
          );
          result.skipped++;
          continue;
      }
      zip.updateFile(entry.entryName, outputBuffer);
      result.recolored++;
      logger.info(
        `[iconRecolor] Greyscaled ${entry.entryName} (${original.length} → ${outputBuffer.length} bytes)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[iconRecolor] Failed to recolor ${entry.entryName}: ${msg}`);
      result.skipped++;
    }
  }

  if (result.recolored > 0) {
    zip.writeZip(apkPath);
    logger.info(
      `[iconRecolor] Wrote ${result.recolored} recolored icon(s) back to ${apkPath} (scanned ${result.scanned}, skipped ${result.skipped})`,
    );
  } else {
    logger.warn(
      `[iconRecolor] No launcher icons were recolored. Photos resource layout may have shifted; recolor step is cosmetic and skipped.`,
    );
  }

  return result;
}
