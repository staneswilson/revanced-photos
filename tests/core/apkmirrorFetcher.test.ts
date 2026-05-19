import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fetchPhotosFromApkMirror, ApkMirrorError } from '../../src/core/apkmirrorFetcher.js';

const LISTING_HTML = `
<!doctype html>
<html><body>
  <div class="listWidget">
    <div class="appRow">
      <h5 class="appRowTitle"><a class="fontBlack" href="/apk/google-inc/photos/google-photos-7-76-0-913939682-release/">Google Photos 7.76.0</a></h5>
    </div>
    <div class="appRow">
      <h5 class="appRowTitle"><a class="fontBlack" href="/apk/google-inc/photos/google-photos-7-75-0-911466973-release/">Google Photos 7.75.0</a></h5>
    </div>
    <div class="appRow">
      <h5 class="appRowTitle"><a class="fontBlack" href="/apk/google-inc/photos/google-photos-7-21-0-737764319-release/">Google Photos 7.21.0</a></h5>
    </div>
  </div>
</body></html>
`;

const RELEASE_HTML = `
<!doctype html>
<html><body>
  <div class="variants-table">
    <div class="table-row headerFont">
      <div class="table-cell"><a href="/apk/google-inc/photos/google-photos-7-76-0-913939682-release/google-photos-7-76-0-android-apk-download/">1</a></div>
      <div class="table-cell">universal</div>
      <div class="table-cell">Android 6.0+</div>
      <div class="table-cell">nodpi</div>
    </div>
    <div class="table-row headerFont">
      <div class="table-cell"><a href="/apk/google-inc/photos/google-photos-7-76-0-913939682-release/google-photos-7-76-0-2-android-apk-download/">2</a></div>
      <div class="table-cell">universal</div>
      <div class="table-cell">Android 12L+</div>
      <div class="table-cell">160-640dpi</div>
    </div>
    <div class="table-row headerFont">
      <div class="table-cell"><a href="/apk/google-inc/photos/google-photos-7-76-0-913939682-release/google-photos-7-76-0-3-android-apk-download/">3</a></div>
      <div class="table-cell">arm64-v8a</div>
      <div class="table-cell">Android 6.0+</div>
      <div class="table-cell">nodpi</div>
    </div>
  </div>
</body></html>
`;

const VARIANT_HTML = `
<!doctype html>
<html><body>
  <a class="downloadButton" href="/wp-content/themes/APKMirror/download.php?id=123456">Download APK</a>
</body></html>
`;

const PREDOWNLOAD_HTML = `
<!doctype html>
<html><body>
  <a id="download-link" href="https://download.apkmirror.com/wp-content/themes/APKMirror/download.php?id=123456&key=abcdef">Click here to start download</a>
</body></html>
`;

// 2 MiB of bytes — comfortably above the 1MB plausibility floor in the fetcher.
const APK_BYTES = new Uint8Array(2_000_000).fill(0x42);

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function htmlResponse(
  body: string,
  init: { status?: number; setCookie?: string[] } = {},
): Response {
  const headers = new Headers({ 'content-type': 'text/html' });
  for (const c of init.setCookie ?? []) headers.append('set-cookie', c);
  return new Response(body, { status: init.status ?? 200, headers });
}

function binaryResponse(body: Uint8Array, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/vnd.android.package-archive' },
  });
}

async function withTempOutput<T>(fn: (outputPath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apkmirror-test-'));
  const outputPath = path.join(dir, 'out.apk');
  try {
    return await fn(outputPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('fetchPhotosFromApkMirror', () => {
  it('resolves the latest version when no pin is provided', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML, { setCookie: ['session=abc; Path=/'] }))
      .mockResolvedValueOnce(htmlResponse(RELEASE_HTML))
      .mockResolvedValueOnce(htmlResponse(VARIANT_HTML))
      .mockResolvedValueOnce(htmlResponse(PREDOWNLOAD_HTML))
      .mockResolvedValueOnce(binaryResponse(APK_BYTES));

    await withTempOutput(async (outputPath) => {
      const result = await fetchPhotosFromApkMirror(undefined, outputPath);
      expect(result.version).toBe('7.76.0.913939682');
      const stat = await fs.stat(outputPath);
      expect(stat.size).toBe(APK_BYTES.length);
    });
  });

  it('matches a 3-segment version pin against the listing slugs', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML))
      .mockResolvedValueOnce(htmlResponse(RELEASE_HTML))
      .mockResolvedValueOnce(htmlResponse(VARIANT_HTML))
      .mockResolvedValueOnce(htmlResponse(PREDOWNLOAD_HTML))
      .mockResolvedValueOnce(binaryResponse(APK_BYTES));

    await withTempOutput(async (outputPath) => {
      const result = await fetchPhotosFromApkMirror('7.75.0', outputPath);
      expect(result.version).toBe('7.75.0.911466973');
      // The release URL the fetcher visited should be the 7.75 one.
      const releaseCall = mockFetch.mock.calls[1]?.[0];
      expect(String(releaseCall)).toContain('google-photos-7-75-0-911466973-release');
    });
  });

  it('prefers the universal variant with the broadest minSdk', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML))
      .mockResolvedValueOnce(htmlResponse(RELEASE_HTML))
      .mockResolvedValueOnce(htmlResponse(VARIANT_HTML))
      .mockResolvedValueOnce(htmlResponse(PREDOWNLOAD_HTML))
      .mockResolvedValueOnce(binaryResponse(APK_BYTES));

    await withTempOutput(async (outputPath) => {
      await fetchPhotosFromApkMirror(undefined, outputPath);
      // Third fetch call = variant page; URL should target the Android 6.0+
      // universal row (the "1" variant), not the Android 12L+ row.
      const variantUrl = String(mockFetch.mock.calls[2]?.[0]);
      expect(variantUrl).toContain('google-photos-7-76-0-android-apk-download');
      expect(variantUrl).not.toContain('-2-android-apk-download');
    });
  });

  it('throws ApkMirrorError on Cloudflare 403 with an actionable hint', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML))
      .mockResolvedValueOnce(htmlResponse(RELEASE_HTML))
      .mockResolvedValueOnce(htmlResponse('forbidden', { status: 403 }));

    await withTempOutput(async (outputPath) => {
      await expect(fetchPhotosFromApkMirror(undefined, outputPath)).rejects.toThrowError(
        ApkMirrorError,
      );
    });
  });

  it('throws when no universal variant is present', async () => {
    const releaseHtmlNoUniversal = RELEASE_HTML.replace(/universal/g, 'arm64-v8a');
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML))
      .mockResolvedValueOnce(htmlResponse(releaseHtmlNoUniversal));

    await withTempOutput(async (outputPath) => {
      await expect(fetchPhotosFromApkMirror(undefined, outputPath)).rejects.toThrow(
        /No universal variant/,
      );
    });
  });

  it('throws when the downloaded file is implausibly small', async () => {
    mockFetch
      .mockResolvedValueOnce(htmlResponse(LISTING_HTML))
      .mockResolvedValueOnce(htmlResponse(RELEASE_HTML))
      .mockResolvedValueOnce(htmlResponse(VARIANT_HTML))
      .mockResolvedValueOnce(htmlResponse(PREDOWNLOAD_HTML))
      .mockResolvedValueOnce(binaryResponse(new Uint8Array(500).fill(0x00)));

    await withTempOutput(async (outputPath) => {
      await expect(fetchPhotosFromApkMirror(undefined, outputPath)).rejects.toThrow(
        /implausibly small/,
      );
    });
  });

  it('throws with a clear message when no slug matches the pin', async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse(LISTING_HTML));

    await withTempOutput(async (outputPath) => {
      await expect(fetchPhotosFromApkMirror('9.99.0', outputPath)).rejects.toThrow(
        /No APKMirror release found matching/,
      );
    });
  });
});
