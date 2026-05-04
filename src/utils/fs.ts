import fs from 'fs/promises';
import { logger } from './logger.js';
import crypto from 'crypto';

/**
 * Securely overwrites a file with random bytes before unlinking it.
 */
export async function secureWipe(filePath: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    const randomData = crypto.randomBytes(stats.size);
    await fs.writeFile(filePath, randomData);
    await fs.unlink(filePath);
    logger.info(`[fs] Securely wiped ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return; // File doesn't exist, nothing to wipe
    }
    logger.error(`[fs] Failed to secure wipe ${filePath}`, error);
    throw error;
  }
}
