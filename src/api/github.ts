import { z } from 'zod';
import { logger } from '../utils/logger.js';

export interface ReleaseAsset {
  name: string;
  downloadUrl: string;
  sha256: string;
}

export interface ReVancedRelease {
  tag: string;
  cli: ReleaseAsset;
  patches: ReleaseAsset;
  integrations: ReleaseAsset;
}

const GithubAssetSchema = z.object({
  name: z.string(),
  browser_download_url: z.string().url(),
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

export async function fetchLatestReVancedRelease(org: string, repo: string): Promise<ReVancedRelease> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'photos-revanced-pipeline',
  };

  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  } else {
    logger.warn('[github] GITHUB_TOKEN not found in env. Rate limits may apply.');
  }

  const response = await fetchWithRetry(`https://api.github.com/repos/${org}/${repo}/releases/latest`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch release for ${repo}: HTTP ${response.status}`);
  }

  const data = await response.json();
  const release = GithubReleaseSchema.parse(data);

  const checksumsAsset = release.assets.find((a) => a.name === 'checksums.txt' || a.name.endsWith('.sha256'));
  if (!checksumsAsset) {
    throw new Error(`No checksums file found in ${repo} release ${release.tag_name}`);
  }

  const checksumsResponse = await fetchWithRetry(checksumsAsset.browser_download_url);
  if (!checksumsResponse.ok) {
    throw new Error(`Failed to fetch checksums for ${repo}: HTTP ${checksumsResponse.status}`);
  }

  const checksumsText = await checksumsResponse.text();
  const checksumMap = new Map<string, string>();
  for (const line of checksumsText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      checksumMap.set(parts[1]!, parts[0]!); // format: hash filename
    }
  }

  const getAsset = (prefix: string): ReleaseAsset => {
    const asset = release.assets.find((a) => a.name.startsWith(prefix) && !a.name.endsWith('.sha256') && !a.name.endsWith('.txt'));
    if (!asset) throw new Error(`Asset starting with ${prefix} not found`);
    const sha256 = checksumMap.get(asset.name);
    if (!sha256) throw new Error(`SHA256 for ${asset.name} not found in checksums`);
    return { name: asset.name, downloadUrl: asset.browser_download_url, sha256 };
  };

  return {
    tag: release.tag_name,
    cli: getAsset('revanced-cli'),
    patches: getAsset('revanced-patches'), // Note: can be .jar or .rvp depending on version, handled by prefix
    integrations: getAsset('revanced-integrations'),
  };
}
