import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { fetchLatestReVancedRelease } from '../../src/api/github.js';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mockReleaseJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/mock-release.json'), 'utf-8'));
const checksumsTxt = fs.readFileSync(path.join(__dirname, '../fixtures/checksums.txt'), 'utf-8');

const server = setupServer(
  // CLI repo
  http.get('https://api.github.com/repos/ReVanced/revanced-cli/releases/latest', () => {
    return HttpResponse.json(mockReleaseJson);
  }),
  // Patches repo
  http.get('https://api.github.com/repos/ReVanced/revanced-patches/releases/latest', () => {
    // Add digest to test the new logic
    const patchesRelease = JSON.parse(JSON.stringify(mockReleaseJson));
    patchesRelease.assets[1].digest = 'sha256:hash_patches_from_digest';
    return HttpResponse.json(patchesRelease);
  }),
  // Integrations repo
  http.get('https://api.github.com/repos/ReVanced/revanced-integrations/releases/latest', () => {
    return HttpResponse.json(mockReleaseJson);
  }),
  // Checksums
  http.get('https://example.com/checksums.txt', () => {
    return HttpResponse.text(checksumsTxt);
  })
);

describe('GitHub API Utils', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    server.resetHandlers();
    vi.clearAllTimers();
  });
  
  afterAll(() => {
    server.close();
    vi.useRealTimers();
  });

  it('should fetch the latest release successfully and parse checksums', async () => {
    const resultPromise = fetchLatestReVancedRelease('ReVanced', 'revanced-cli');
    
    // The implementation has no retries on success, but it makes multiple calls.
    // If it hits an unhandled request or something, it might retry.
    // Since we mocked all, it should be fast.
    
    const result = await resultPromise;
    expect(result.tag).toBe('v1.0.0');
    expect(result.cli.name).toBe('revanced-cli-1.0.0.jar');
    expect(result.cli.sha256).toBe('hash_cli');
    // For patches, we mocked it to use digest
    expect(result.patches.sha256).toBe('hash_patches_from_digest');
    expect(result.integrations?.sha256).toBe('hash_integrations');
  });

  it('should throw an error if the API call fails 3 times', async () => {
    server.use(
      http.get('https://api.github.com/repos/ReVanced/revanced-cli/releases/latest', () => {
        return new HttpResponse(null, { status: 500 });
      })
    );
    
    let caughtError: any;
    const resultPromise = fetchLatestReVancedRelease('ReVanced', 'revanced-cli').catch((e) => {
      caughtError = e;
    });
    
    // Advance timers manually to trigger retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    
    await resultPromise;
    expect(caughtError?.message).toContain('HTTP 500');
  });

  it('should handle missing integrations gracefully', async () => {
    server.use(
      http.get('https://api.github.com/repos/ReVanced/revanced-integrations/releases/latest', () => {
        return new HttpResponse(null, { status: 404 });
      })
    );
    
    const result = await fetchLatestReVancedRelease('ReVanced', 'revanced-cli');
    expect(result.integrations).toBeNull();
  });
});
