import crypto from 'crypto';
import fs from 'fs';

/**
 * Calculates the SHA256 checksum of a file.
 * @param filePath The absolute or relative path to the file.
 * @returns The hex representation of the SHA256 hash.
 */
export function calculateSHA256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (data) => {
      hash.update(data);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Verifies the integrity of a file against an expected SHA256 checksum.
 * @param filePath The path to the file to verify.
 * @param expectedHash The expected SHA256 hash.
 * @returns True if the hash matches, false otherwise.
 */
export async function verifyChecksum(filePath: string, expectedHash: string): Promise<boolean> {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found for checksum verification: ${filePath}`);
      return false;
    }
    const actualHash = await calculateSHA256(filePath);
    return actualHash.toLowerCase() === expectedHash.toLowerCase();
  } catch (error) {
    console.error(`Error calculating checksum for ${filePath}:`, error);
    return false;
  }
}
