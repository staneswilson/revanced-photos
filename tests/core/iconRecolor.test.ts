import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { recolorLauncherIcons } from '../../src/core/iconRecolor.js';

async function makeColorPng(): Promise<Buffer> {
  // Solid red 8x8 PNG. Grayscale conversion turns red (#ff0000) into a uniform
  // mid-gray (~76 in luminance space), so we can detect a successful recolor
  // by reading any pixel of the output and seeing R == G == B.
  return sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

async function isGrayscalePng(buffer: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  // For each pixel, R == G == B → grayscale.
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) return false;
  }
  return true;
}

describe('iconRecolor', () => {
  let tempApkPath: string;

  beforeEach(() => {
    tempApkPath = path.join(
      os.tmpdir(),
      `iconRecolor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.apk`,
    );
  });

  afterEach(async () => {
    try {
      await fs.unlink(tempApkPath);
    } catch {
      // already gone
    }
  });

  it('grayscales a launcher icon PNG and writes back into the zip', async () => {
    const colorPng = await makeColorPng();
    const zip = new AdmZip();
    zip.addFile('res/mipmap-mdpi/ic_launcher.png', colorPng);
    zip.addFile('res/values/strings.xml', Buffer.from('<resources/>'));
    zip.writeZip(tempApkPath);

    const result = await recolorLauncherIcons(tempApkPath);
    expect(result.scanned).toBe(1);
    expect(result.recolored).toBe(1);
    expect(result.skipped).toBe(0);

    const written = new AdmZip(tempApkPath);
    const recoloredEntry = written.getEntry('res/mipmap-mdpi/ic_launcher.png');
    expect(recoloredEntry).not.toBeNull();
    const recoloredBuffer = recoloredEntry!.getData();
    expect(await isGrayscalePng(recoloredBuffer)).toBe(true);
  });

  it('matches multiple icon path patterns (mipmap variants and adaptive foreground)', async () => {
    const colorPng = await makeColorPng();
    const zip = new AdmZip();
    zip.addFile('res/mipmap-xxhdpi/ic_launcher.png', colorPng);
    zip.addFile('res/mipmap-anydpi-v26/ic_launcher_round.png', colorPng);
    zip.addFile('res/drawable-xxhdpi/ic_launcher_foreground.png', colorPng);
    zip.addFile('res/values/strings.xml', Buffer.from('<resources/>'));
    zip.writeZip(tempApkPath);

    const result = await recolorLauncherIcons(tempApkPath);
    expect(result.scanned).toBe(3);
    expect(result.recolored).toBe(3);
  });

  it('warns and returns zeros when no launcher icons are present (does not throw)', async () => {
    const zip = new AdmZip();
    zip.addFile('res/values/strings.xml', Buffer.from('<resources/>'));
    zip.addFile('AndroidManifest.xml', Buffer.from('placeholder'));
    zip.writeZip(tempApkPath);

    const result = await recolorLauncherIcons(tempApkPath);
    expect(result.scanned).toBe(0);
    expect(result.recolored).toBe(0);
  });

  it('counts a corrupt icon as skipped without aborting the rest', async () => {
    const colorPng = await makeColorPng();
    const zip = new AdmZip();
    zip.addFile('res/mipmap-mdpi/ic_launcher.png', colorPng);
    zip.addFile('res/mipmap-hdpi/ic_launcher.png', Buffer.from('not a real image'));
    zip.writeZip(tempApkPath);

    const result = await recolorLauncherIcons(tempApkPath);
    expect(result.scanned).toBe(2);
    expect(result.recolored).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
