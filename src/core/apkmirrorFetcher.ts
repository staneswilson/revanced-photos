import { load as loadHtml } from 'cheerio';
import fs from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

import { logger } from '../utils/logger.js';
import { logAbiInventory } from './abiInventory.js';

// APKMirror DOM selectors. APKMirror's HTML has been stable for years but
// these are the single point of failure if they redesign — keep them grouped.
const SELECTORS = {
  listingRow: 'div.appRow h5.appRowTitle a, div.listWidget h5.appRowTitle a',
  variantRow: 'div.table-row.headerFont',
  variantCell: 'div.table-cell',
  variantLink: 'a',
  downloadButton: 'a.downloadButton',
  finalDownloadLink: 'a#download-link, a.accent_bg.btn.btn-flat',
} as const;

const APKMIRROR_BASE = 'https://www.apkmirror.com';
const PHOTOS_LISTING_PATH = '/apk/google-inc/photos/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/121.0.0.0 Safari/537.36';

export class ApkMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkMirrorError';
  }
}

export interface ApkMirrorResult {
  version: string;
  outputPath: string;
}

// Cookie jar: tracks name=value pairs from Set-Cookie headers across the
// scrape chain. APKMirror sets a session cookie + Cloudflare cf_clearance on
// the first hit; subsequent variant/download pages require them. We don't do
// domain/path matching — single-host scrape, single jar.
class CookieJar {
  private cookies = new Map<string, string>();

  update(response: Response): void {
    const setCookies = (
      response.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.();
    if (!setCookies) return;
    for (const sc of setCookies) {
      const firstPair = sc.split(';')[0];
      if (!firstPair) continue;
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header(): string {
    return Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ');
  }
}

function browserHeaders(jar: CookieJar, referer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
  };
  const cookie = jar.header();
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;
  return headers;
}

async function fetchPage(url: string, jar: CookieJar, referer?: string): Promise<string> {
  const response = await fetch(url, { headers: browserHeaders(jar, referer), redirect: 'follow' });
  jar.update(response);
  if (!response.ok) {
    throw new ApkMirrorError(
      `GET ${url} → HTTP ${response.status} ${response.statusText}. ` +
        `APKMirror may be blocking the CI runner IP or has redesigned the page. ` +
        `Set APK_SOURCE=apkpure to force the fallback.`,
    );
  }
  return response.text();
}

function absoluteUrl(href: string): string {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `${APKMIRROR_BASE}${href}`;
  return `${APKMIRROR_BASE}/${href}`;
}

// Normalize a version pin into the slug substring APKMirror uses.
// `7.76.0` → `7-76-0`; `7.76.0.913939682` → `7-76-0-913939682`. Either form is
// accepted in the input; the slug match is a substring check, so a shorter
// pin like `7.76.0` matches any 7.76.0.X release.
function versionToSlugFragment(version: string): string {
  return version.replace(/\./g, '-');
}

interface ResolvedVersion {
  releaseUrl: string;
  slug: string; // e.g. "google-photos-7-76-0-913939682-release"
  version: string; // e.g. "7.76.0.913939682"
}

function parseListingForVersion(html: string, versionPin: string | undefined): ResolvedVersion {
  const $ = loadHtml(html);
  const anchors = $(SELECTORS.listingRow).toArray();

  if (anchors.length === 0) {
    throw new ApkMirrorError(
      `APKMirror listing page returned no version rows. Selector "${SELECTORS.listingRow}" ` +
        `matched nothing. The page may have been redesigned.`,
    );
  }

  const candidates: ResolvedVersion[] = [];
  for (const a of anchors) {
    const href = $(a).attr('href');
    if (!href) continue;
    const url = absoluteUrl(href);
    const m = url.match(/\/apk\/[^/]+\/[^/]+\/([^/]+-release)\/?$/);
    if (!m) continue;
    const slug = m[1]!;
    // Extract version from slug, e.g. "google-photos-7-76-0-913939682-release"
    const versionMatch = slug.match(/-(\d+(?:-\d+){2,3})-release$/);
    if (!versionMatch) continue;
    const version = versionMatch[1]!.replace(/-/g, '.');
    candidates.push({ releaseUrl: url, slug, version });
  }

  if (candidates.length === 0) {
    throw new ApkMirrorError(
      `APKMirror listing page returned anchors but none matched the Photos release-slug ` +
        `pattern. The site URL scheme may have changed.`,
    );
  }

  if (!versionPin) {
    // Listing is newest-first; topmost candidate is latest.
    const latest = candidates[0]!;
    logger.info(`[apkmirror] No version pin; using latest from listing: ${latest.version}`);
    return latest;
  }

  const slugFragment = versionToSlugFragment(versionPin);
  const match = candidates.find((c) => c.slug.includes(slugFragment));
  if (!match) {
    throw new ApkMirrorError(
      `No APKMirror release found matching version pin "${versionPin}" (slug fragment ` +
        `"${slugFragment}"). Top candidates: ${candidates
          .slice(0, 5)
          .map((c) => c.version)
          .join(', ')}.`,
    );
  }
  logger.info(`[apkmirror] Matched pin ${versionPin} → ${match.version}`);
  return match;
}

interface VariantRow {
  variantUrl: string;
  arch: string;
  minApi: string;
  dpi: string;
}

function parseVariantsForUniversal(html: string, releaseUrl: string): VariantRow {
  const $ = loadHtml(html);
  const rows = $(SELECTORS.variantRow).toArray();
  if (rows.length === 0) {
    throw new ApkMirrorError(
      `Release page ${releaseUrl} had no variants table rows ("${SELECTORS.variantRow}").`,
    );
  }

  const parsed: VariantRow[] = [];
  for (const row of rows) {
    const cells = $(row).find(SELECTORS.variantCell).toArray();
    if (cells.length < 4) continue;
    // APKMirror variants table layout: [Variant#, Arch, Min Android, DPI, ...]
    const variantLink = $(cells[0]).find(SELECTORS.variantLink).attr('href');
    const arch = $(cells[1]).text().trim().toLowerCase();
    const minApi = $(cells[2]).text().trim();
    const dpi = $(cells[3]).text().trim();
    if (!variantLink) continue;
    parsed.push({ variantUrl: absoluteUrl(variantLink), arch, minApi, dpi });
  }

  if (parsed.length === 0) {
    throw new ApkMirrorError(`Release page ${releaseUrl} had rows but none parsed cleanly.`);
  }

  const universals = parsed.filter((v) => v.arch === 'universal' || v.arch === 'noarch');
  if (universals.length === 0) {
    throw new ApkMirrorError(
      `No universal variant in release ${releaseUrl}. Available archs: ` +
        `${[...new Set(parsed.map((p) => p.arch))].join(', ')}. Pin an older version that has ` +
        `a universal build, or set APK_SOURCE=apkpure.`,
    );
  }

  // When multiple universals exist (Photos often has Android 6.0+ and Android
  // 12L+ universal rows), prefer the broadest minSdk (lowest number). DPI
  // doesn't affect installability so we don't filter on it.
  universals.sort((a, b) => {
    const apiA = parseFloat(a.minApi.match(/[\d.]+/)?.[0] ?? '99');
    const apiB = parseFloat(b.minApi.match(/[\d.]+/)?.[0] ?? '99');
    return apiA - apiB;
  });

  const chosen = universals[0]!;
  logger.info(
    `[apkmirror] Selected universal variant (Min ${chosen.minApi}, DPI ${chosen.dpi}): ${chosen.variantUrl}`,
  );
  return chosen;
}

function parseDownloadButton(html: string, variantUrl: string): string {
  const $ = loadHtml(html);
  const href = $(SELECTORS.downloadButton).first().attr('href');
  if (!href) {
    throw new ApkMirrorError(
      `Variant page ${variantUrl} did not expose a download button ` +
        `("${SELECTORS.downloadButton}").`,
    );
  }
  return absoluteUrl(href);
}

function parseFinalDownloadLink(html: string, downloadPageUrl: string): string {
  const $ = loadHtml(html);
  const href = $(SELECTORS.finalDownloadLink).first().attr('href');
  if (!href) {
    throw new ApkMirrorError(
      `Pre-download page ${downloadPageUrl} did not expose a final download link ` +
        `("${SELECTORS.finalDownloadLink}").`,
    );
  }
  return absoluteUrl(href);
}

async function downloadToFile(
  url: string,
  outputPath: string,
  jar: CookieJar,
  referer: string,
): Promise<void> {
  const response = await fetch(url, { headers: browserHeaders(jar, referer), redirect: 'follow' });
  jar.update(response);
  if (!response.ok) {
    throw new ApkMirrorError(
      `Final APK download GET ${url} → HTTP ${response.status} ${response.statusText}.`,
    );
  }
  if (!response.body) {
    throw new ApkMirrorError(`Final APK download GET ${url} returned no body.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath));
  const stat = await fs.stat(outputPath);
  if (stat.size < 1_000_000) {
    throw new ApkMirrorError(
      `Downloaded APK at ${outputPath} is implausibly small (${stat.size} bytes). ` +
        `APKMirror may have served an error page.`,
    );
  }
  logger.info(`[apkmirror] Wrote ${stat.size} bytes to ${outputPath}`);
}

export async function fetchPhotosFromApkMirror(
  versionPin: string | undefined,
  outputPath: string,
): Promise<ApkMirrorResult> {
  const jar = new CookieJar();
  const listingUrl = `${APKMIRROR_BASE}${PHOTOS_LISTING_PATH}`;

  logger.info(`[apkmirror] Fetching listing ${listingUrl}`);
  const listingHtml = await fetchPage(listingUrl, jar);
  const resolved = parseListingForVersion(listingHtml, versionPin);

  logger.info(`[apkmirror] Fetching release page ${resolved.releaseUrl}`);
  const releaseHtml = await fetchPage(resolved.releaseUrl, jar, listingUrl);
  const variant = parseVariantsForUniversal(releaseHtml, resolved.releaseUrl);

  logger.info(`[apkmirror] Fetching variant page ${variant.variantUrl}`);
  const variantHtml = await fetchPage(variant.variantUrl, jar, resolved.releaseUrl);
  const downloadPageUrl = parseDownloadButton(variantHtml, variant.variantUrl);

  logger.info(`[apkmirror] Fetching pre-download page ${downloadPageUrl}`);
  const downloadPageHtml = await fetchPage(downloadPageUrl, jar, variant.variantUrl);
  const finalUrl = parseFinalDownloadLink(downloadPageHtml, downloadPageUrl);

  logger.info(`[apkmirror] Downloading APK from ${finalUrl}`);
  await downloadToFile(finalUrl, outputPath, jar, downloadPageUrl);
  logAbiInventory(outputPath, 'APKMirror APK');

  return { version: resolved.version, outputPath };
}
