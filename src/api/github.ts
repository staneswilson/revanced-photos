import { z } from 'zod';
import { logger } from '../utils/logger.js';

export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  // Null when the source (e.g. ReVanced v5 API) publishes no hash.
  sha256: string | null;
}

const REVANCED_API_PATCHES_URL = 'https://api.revanced.app/v5/patches';

const RevancedApiPatchesSchema = z.object({
  version: z.string(),
  download_url: z.string().url(),
});

export interface ReVancedRelease {
  tag: string;
  cli: ReleaseAsset;
  patches: ReleaseAsset;
  /** integrations is optional — removed in CLI v6+ */
  integrations: ReleaseAsset | null;
}

const GithubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
  // CLI v6+ embeds sha256 as "sha256:<hex>" in the digest field
  digest: z.string().optional().nullable(),
});

const GithubReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(GithubAssetSchema),
});

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  const delays = [1000, 2000, 4000];
  let lastError: Error | null = null;

  for (let i = 0; i <= delays.length; i++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error as Error;
      if (i < delays.length) {
        logger.warn(`[github] Fetch failed: ${lastError.message}. Retrying in ${delays[i]!}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delays[i]));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Unknown error'));
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'photos-revanced-pipeline',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  } else {
    logger.warn('[github] GITHUB_TOKEN not found in env. Rate limits may apply.');
  }
  return headers;
}

async function fetchRelease(org: string, repo: string) {
  const headers = buildHeaders();
  const url = `https://api.github.com/repos/${org}/${repo}/releases/latest`;
  const response = await fetchWithRetry(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch release for ${repo}: HTTP ${response.status}`);
  }
  const data = await response.json();
  return GithubReleaseSchema.parse(data);
}

/**
 * Extracts SHA-256 from an asset.
 * Tries the `digest` field first (CLI v6+: "sha256:<hex>"),
 * then falls back to a sibling `.sha256` asset,
 * then falls back to a `checksums.txt` asset.
 */
async function resolveAsset(
  assetNamePrefix: string,
  assets: z.infer<typeof GithubReleaseSchema>['assets'],
  fetchFallbackChecksums?: () => Promise<Map<string, string>>,
): Promise<ReleaseAsset> {
  const asset = assets.find(
    (a) =>
      a.name.startsWith(assetNamePrefix) &&
      !a.name.endsWith('.sha256') &&
      !a.name.endsWith('.asc') &&
      !a.name.endsWith('.txt'),
  );
  if (!asset) throw new Error(`Asset with prefix "${assetNamePrefix}" not found in release`);

  // Strategy 1: digest field (CLI v6+)
  if (asset.digest && asset.digest.startsWith('sha256:')) {
    const sha256 = asset.digest.slice('sha256:'.length);
    logger.info(`[github] Using digest field for ${asset.name}: ${sha256.slice(0, 16)}...`);
    return { name: asset.name, downloadUrl: asset.browser_download_url, sha256 };
  }

  // Strategy 2: sibling .sha256 file
  const sha256Asset = assets.find((a) => a.name === `${asset.name}.sha256`);
  if (sha256Asset) {
    const resp = await fetchWithRetry(sha256Asset.browser_download_url);
    const sha256 = (await resp.text()).trim().split(/\s+/)[0]!;
    logger.info(`[github] Using .sha256 sidecar for ${asset.name}`);
    return { name: asset.name, downloadUrl: asset.browser_download_url, sha256 };
  }

  // Strategy 3: checksums.txt
  if (fetchFallbackChecksums) {
    const map = await fetchFallbackChecksums();
    const sha256 = map.get(asset.name);
    if (sha256) {
      logger.info(`[github] Using checksums.txt for ${asset.name}`);
      return { name: asset.name, downloadUrl: asset.browser_download_url, sha256 };
    }
  }

  throw new Error(`Could not resolve SHA-256 for ${asset.name}`);
}

// Fallback when GitHub returns 451 for revanced-patches. No SHA-256 in this feed.
async function fetchPatchesFromRevancedApi(): Promise<ReleaseAsset> {
  logger.info(`[github] Falling back to official ReVanced API: ${REVANCED_API_PATCHES_URL}`);
  const response = await fetchWithRetry(REVANCED_API_PATCHES_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'photos-revanced-pipeline' },
  });
  if (!response.ok) {
    throw new Error(`ReVanced API patches fetch failed: HTTP ${response.status}`);
  }
  const data = RevancedApiPatchesSchema.parse(await response.json());
  const cleanVersion = data.version.replace(/^v/, '');
  return {
    name: `revanced-patches-${cleanVersion}.rvp`,
    downloadUrl: data.download_url,
    sha256: null,
  };
}

export async function fetchLatestReVancedRelease(
  org: string,
  repo: string,
): Promise<ReVancedRelease> {
  // CLI v6 ships everything in one repo: revanced-cli
  // Patches are now `.rvp` bundles from revanced-patches (separate repo, same pattern)
  logger.info(`[github] Fetching CLI release from ${org}/${repo}...`);
  const cliRelease = await fetchRelease(org, 'revanced-cli');

  // Build optional checksums.txt fallback
  const checksumsAsset = cliRelease.assets.find(
    (a) => a.name === 'checksums.txt' || a.name.endsWith('.sha256sum'),
  );
  let checksumsMap: Map<string, string> | null = null;
  const fetchFallback = checksumsAsset
    ? async () => {
        if (checksumsMap) return checksumsMap;
        const resp = await fetchWithRetry(checksumsAsset.browser_download_url);
        const text = await resp.text();
        checksumsMap = new Map<string, string>();
        for (const line of text.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) checksumsMap.set(parts[1]!, parts[0]!);
        }
        return checksumsMap;
      }
    : undefined;

  const cli = await resolveAsset('revanced-cli', cliRelease.assets, fetchFallback);

  // Patches — try fetching from revanced-patches repo
  let patches: ReleaseAsset;
  try {
    logger.info(`[github] Fetching patches release from ${org}/revanced-patches...`);
    const patchesRelease = await fetchRelease(org, 'revanced-patches');
    const patchChecksumsAsset = patchesRelease.assets.find(
      (a) => a.name === 'checksums.txt' || a.name.endsWith('.sha256sum'),
    );
    const fetchPatchFallback = patchChecksumsAsset
      ? async () => {
          const resp = await fetchWithRetry(patchChecksumsAsset.browser_download_url);
          const text = await resp.text();
          const map = new Map<string, string>();
          for (const line of text.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) map.set(parts[1]!, parts[0]!);
          }
          return map;
        }
      : undefined;
    patches = await resolveAsset('revanced-patches', patchesRelease.assets, fetchPatchFallback);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[github] Could not fetch patches from revanced-patches repo: ${msg}`);
    logger.warn(`[github] Trying patches bundled with CLI release...`);
    try {
      patches = await resolveAsset('revanced-patches', cliRelease.assets, fetchFallback);
    } catch (cliErr) {
      const cliMsg = cliErr instanceof Error ? cliErr.message : String(cliErr);
      logger.warn(`[github] CLI release does not bundle patches: ${cliMsg}`);
      patches = await fetchPatchesFromRevancedApi();
    }
  }

  // Integrations — optional (removed in CLI v6+)
  let integrations: ReleaseAsset | null = null;
  try {
    const integrationsRelease = await fetchRelease(org, 'revanced-integrations');
    const integrationChecksumsAsset = integrationsRelease.assets.find(
      (a) => a.name === 'checksums.txt' || a.name.endsWith('.sha256sum'),
    );
    const fetchIntegrationFallback = integrationChecksumsAsset
      ? async () => {
          const resp = await fetchWithRetry(integrationChecksumsAsset.browser_download_url);
          const text = await resp.text();
          const map = new Map<string, string>();
          for (const line of text.split('\n')) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) map.set(parts[1]!, parts[0]!);
          }
          return map;
        }
      : undefined;

    integrations = await resolveAsset(
      'revanced-integrations',
      integrationsRelease.assets,
      fetchIntegrationFallback,
    );
    logger.info(`[github] Integrations: ${integrations.name}`);
  } catch {
    logger.info(`[github] No integrations found (expected for CLI v6+, skipping)`);
  }

  logger.info(`[github] CLI: ${cli.name} | Patches: ${patches.name}`);
  return { tag: cliRelease.tag_name, cli, patches, integrations };
}
