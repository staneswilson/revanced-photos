import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { logger } from '../utils/logger.js';

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export async function downloadFile(url: string, outputPath: string, label?: string): Promise<void> {
  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new DownloadError(`HTTP ${response.status} downloading ${url}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  let receivedBytes = 0;
  let lastLogTime = 0;

  // We need to convert the Web ReadableStream to a Node Readable stream to pipe easily
  // In Node 20, we can use Readable.fromWeb
  const nodeStream = Readable.fromWeb(response.body as any);

  nodeStream.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length;
    const now = Date.now();
    if (now - lastLogTime > 1000) {
      lastLogTime = now;
      const receivedMB = (receivedBytes / 1024 / 1024).toFixed(2);
      if (totalBytes > 0) {
        const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
        const percent = ((receivedBytes / totalBytes) * 100).toFixed(1);
        process.stderr.write(
          `\r[downloader] ${label || 'file'} — ${receivedMB}MB / ${totalMB}MB (${percent}%)`,
        );
      } else {
        process.stderr.write(`\r[downloader] ${label || 'file'} — ${receivedMB}MB received`);
      }
    }
  });

  const fileStream = fs.createWriteStream(outputPath);

  try {
    await pipeline(nodeStream, fileStream);
    process.stderr.write('\n'); // Clear line after download
    logger.info(`[downloader] Finished downloading ${label || outputPath}`);
  } catch (err) {
    process.stderr.write('\n');
    throw new DownloadError(`Stream error during download: ${(err as Error).message}`);
  }
}
