import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { logger } from '../utils/logger.js';

export class VerificationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly expected: string,
    public readonly actual: string,
  ) { 
    super(`Checksum mismatch for ${filePath}`);
    this.name = 'VerificationError';
  }
}

export async function verifySha256(filePath: string, expectedHash: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found for verification: ${filePath}`);
  }

  const hash = crypto.createHash('sha256');
  const readStream = fs.createReadStream(filePath);

  await pipeline(readStream, hash);

  const actualHash = hash.digest('hex');

  if (actualHash !== expectedHash) {
    logger.error(`[verifier] Checksum mismatch for ${filePath}. Expected: ${expectedHash}, Actual: ${actualHash}`);
    throw new VerificationError(filePath, expectedHash, actualHash);
  }

  logger.info(`[verifier] Checksum verified for ${filePath}`);
}
