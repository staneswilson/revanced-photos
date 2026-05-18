import AdmZip from 'adm-zip';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

export interface IconRecolorResult {
  scanned: number;
  recolored: number;
  skipped: number;
}

// Photos names launcher icons `adaptiveproduct_*_foreground_*` (adaptive icon
// bitmap foreground used on Android 8+) and `product_logo_*_launcher_*` (the
// raster fallback for Android <8 and the round-icon variant). The generic
// `ic_launcher*` pattern stays for forks that target other apps.
const ICON_PATTERNS: readonly RegExp[] = [
  /^res\/mipmap-[^/]+\/(ic_launcher|adaptiveproduct.*_foreground|product_logo.*_launcher).*\.(png|webp)$/i,
  /^res\/drawable-[^/]+\/ic_launcher_foreground.*\.(png|webp)$/i,
];

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
    // Dump every entry whose path mentions "launcher" so the next CI run shows what's there.
    const candidates = entries
      .filter((e) => !e.isDirectory && e.entryName.toLowerCase().includes('launcher'))
      .map((e) => e.entryName);
    logger.warn(
      `[iconRecolor] No launcher icons matched. Entries containing "launcher" (first 30): ${candidates.slice(0, 30).join(', ') || '(none)'}`,
    );
  }

  return result;
}
