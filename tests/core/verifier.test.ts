import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifySha256, VerificationError } from '../../src/core/verifier.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

describe('Verifier', () => {
  const testFile = path.join(__dirname, '../fixtures/test-verifier.txt');
  let validHash = '';

  beforeAll(() => {
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(testFile, 'test data for verifier');
    validHash = crypto.createHash('sha256').update('test data for verifier').digest('hex');
  });

  afterAll(() => {
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
  });

  it('should resolve when actual SHA256 matches expected', async () => {
    await expect(verifySha256(testFile, validHash)).resolves.toBeUndefined();
  });

  it('should throw VerificationError on mismatch', async () => {
    const errorPromise = verifySha256(testFile, 'invalid-hash');
    await expect(errorPromise).rejects.toThrowError(VerificationError);

    try {
      await errorPromise;
    } catch (e: any) {
      expect(e.expected).toBe('invalid-hash');
      expect(e.actual).toBe(validHash);
    }
  });

  it('should throw a clear error when file does not exist', async () => {
    await expect(verifySha256('non-existent.txt', validHash)).rejects.toThrow(/File not found/);
  });
});
