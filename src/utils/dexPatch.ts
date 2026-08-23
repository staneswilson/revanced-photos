import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * Computes standard Adler32 checksum used by Dalvik DEX headers.
 */
export function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  const MOD_ADLER = 65521;
  const len = buf.length;
  for (let i = 0; i < len; i++) {
    a = (a + buf[i]!) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Reads an unsigned LEB128 value from buffer at offset.
 */
export function readUleb128(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead]!;
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, bytesRead };
}

/**
 * Validates whether the buffer starts with a valid DEX header.
 */
export function isValidDex(buffer: Buffer): boolean {
  if (buffer.length < 0x70) return false;
  const magic = buffer.subarray(0, 8).toString('ascii');
  return /^dex\n\d{3}\0$/.test(magic);
}

/**
 * Recalculates SHA-1 signature and Adler32 checksum for a DEX buffer.
 */
export function updateDexChecksums(buffer: Buffer): void {
  // 1. SHA-1 signature over all bytes starting at offset 32 (after header signature)
  const sha1 = crypto.createHash('sha1').update(buffer.subarray(32)).digest();
  sha1.copy(buffer, 12);

  // 2. Adler32 checksum over all bytes starting at offset 12 (after checksum field)
  const checksum = adler32(buffer.subarray(12));
  buffer.writeUInt32LE(checksum, 8);
}

/**
 * Reads a null-terminated MUTF-8 string from the DEX string pool.
 */
export function getDexString(buffer: Buffer, stringIdIndex: number, stringIdsOff: number): string {
  const dataOff = buffer.readUInt32LE(stringIdsOff + stringIdIndex * 4);
  const { bytesRead } = readUleb128(buffer, dataOff);
  const start = dataOff + bytesRead;
  let end = start;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }
  return buffer.toString('utf8', start, end);
}

export interface DexPatchResult {
  patched: boolean;
  patchedMethods: string[];
}

/**
 * Scans a DEX buffer for `GmsCoreSupport$GmsCore.checkUpdates()` (or `GmsCoreSupport.checkUpdates()`)
 * and patches the method bytecode to `return-void` (opcode 0x000E).
 *
 * This permanently prevents `NullPointerException` in `BaseSettings.<clinit>` / `SharedPrefCategory.<init>`
 * when Google Photos starts up without an existing Application context hook.
 */
export function patchGmsCoreSupportDex(dexBuffer: Buffer): DexPatchResult {
  if (!isValidDex(dexBuffer)) {
    return { patched: false, patchedMethods: [] };
  }

  const stringIdsSize = dexBuffer.readUInt32LE(56);
  const stringIdsOff = dexBuffer.readUInt32LE(60);
  const typeIdsSize = dexBuffer.readUInt32LE(64);
  const typeIdsOff = dexBuffer.readUInt32LE(68);
  const protoIdsSize = dexBuffer.readUInt32LE(72);
  const protoIdsOff = dexBuffer.readUInt32LE(76);
  const methodIdsSize = dexBuffer.readUInt32LE(88);
  const methodIdsOff = dexBuffer.readUInt32LE(92);
  const classDefsSize = dexBuffer.readUInt32LE(96);
  const classDefsOff = dexBuffer.readUInt32LE(100);

  if (stringIdsSize === 0 || typeIdsSize === 0 || methodIdsSize === 0 || classDefsSize === 0) {
    return { patched: false, patchedMethods: [] };
  }

  // Quick zero-copy heuristic: Check if target class/method string exists anywhere in the DEX before full parsing
  if (
    !dexBuffer.includes('GmsCoreSupport') &&
    !dexBuffer.includes('checkUpdates') &&
    !dexBuffer.includes('checkGmsCore') &&
    !dexBuffer.includes('BaseSettings') &&
    !dexBuffer.includes('settings/Setting')
  ) {
    return { patched: false, patchedMethods: [] };
  }

  const getTypeDescriptor = (typeIdx: number): string => {
    if (typeIdx >= typeIdsSize) return '';
    const descriptorIdx = dexBuffer.readUInt32LE(typeIdsOff + typeIdx * 4);
    if (descriptorIdx >= stringIdsSize) return '';
    return getDexString(dexBuffer, descriptorIdx, stringIdsOff);
  };

  const getMethodInfo = (
    methodIdx: number,
  ): { className: string; methodName: string; returnType: string } => {
    if (methodIdx >= methodIdsSize) return { className: '', methodName: '', returnType: '' };
    const off = methodIdsOff + methodIdx * 8;
    const classIdx = dexBuffer.readUInt16LE(off);
    const protoIdx = dexBuffer.readUInt16LE(off + 2);
    const nameIdx = dexBuffer.readUInt32LE(off + 4);
    const className = getTypeDescriptor(classIdx);
    const methodName =
      nameIdx < stringIdsSize ? getDexString(dexBuffer, nameIdx, stringIdsOff) : '';

    let returnType = '';
    if (protoIdx < protoIdsSize) {
      const protoOff = protoIdsOff + protoIdx * 12;
      const returnTypeIdx = dexBuffer.readUInt32LE(protoOff + 4);
      returnType = getTypeDescriptor(returnTypeIdx);
    }
    return { className, methodName, returnType };
  };

  let patched = false;
  const patchedMethods: string[] = [];

  // Iterate class definitions (each entry is 32 bytes)
  for (let c = 0; c < classDefsSize; c++) {
    const classDefOff = classDefsOff + c * 32;
    const classIdx = dexBuffer.readUInt32LE(classDefOff);
    const classDescriptor = getTypeDescriptor(classIdx);

    if (
      !classDescriptor.includes('GmsCoreSupport') &&
      !classDescriptor.includes('app/revanced/extension/shared')
    ) {
      continue;
    }

    const classDataOff = dexBuffer.readUInt32LE(classDefOff + 24);
    if (classDataOff === 0 || classDataOff >= dexBuffer.length) continue;

    let cursor = classDataOff;

    const numStaticFields = readUleb128(dexBuffer, cursor);
    cursor += numStaticFields.bytesRead;

    const numInstanceFields = readUleb128(dexBuffer, cursor);
    cursor += numInstanceFields.bytesRead;

    const numDirectMethods = readUleb128(dexBuffer, cursor);
    cursor += numDirectMethods.bytesRead;

    const numVirtualMethods = readUleb128(dexBuffer, cursor);
    cursor += numVirtualMethods.bytesRead;

    // Skip static fields
    for (let f = 0; f < numStaticFields.value; f++) {
      cursor += readUleb128(dexBuffer, cursor).bytesRead; // field_idx_diff
      cursor += readUleb128(dexBuffer, cursor).bytesRead; // access_flags
    }

    // Skip instance fields
    for (let f = 0; f < numInstanceFields.value; f++) {
      cursor += readUleb128(dexBuffer, cursor).bytesRead; // field_idx_diff
      cursor += readUleb128(dexBuffer, cursor).bytesRead; // access_flags
    }

    const inspectMethods = (count: number) => {
      let cumulativeMethodIdx = 0;
      for (let m = 0; m < count; m++) {
        const methodIdxDiff = readUleb128(dexBuffer, cursor);
        cursor += methodIdxDiff.bytesRead;
        cumulativeMethodIdx += methodIdxDiff.value;

        const accessFlags = readUleb128(dexBuffer, cursor);
        cursor += accessFlags.bytesRead;

        const codeOff = readUleb128(dexBuffer, cursor);
        cursor += codeOff.bytesRead;

        if (codeOff.value === 0 || codeOff.value >= dexBuffer.length) continue;

        const { className, methodName, returnType } = getMethodInfo(cumulativeMethodIdx);

        // Match checkUpdates, checkGmsCore, check methods, and BaseSettings/Setting static initializers
        const isGmsSupportClass =
          className.includes('GmsCoreSupport') ||
          className.includes('app/revanced/extension/shared/GmsCore');
        const isTargetCheckMethod =
          methodName === 'checkUpdates' ||
          methodName === 'checkGmsCore' ||
          (methodName === 'check' && isGmsSupportClass);

        const isSettingsClinit =
          methodName === '<clinit>' &&
          (className.includes('BaseSettings') || className.includes('settings/Setting'));

        if ((isGmsSupportClass && isTargetCheckMethod) || isSettingsClinit) {
          const codeItemOff = codeOff.value;
          const insnsSize = dexBuffer.readUInt32LE(codeItemOff + 12);
          // Dalvik opcode 0x000E is return-void, valid for methods with void return descriptor 'V'
          if (
            insnsSize > 0 &&
            codeItemOff + 16 <= dexBuffer.length &&
            (returnType === 'V' || returnType === '')
          ) {
            const originalOpcode = dexBuffer.readUInt16LE(codeItemOff + 16);
            if (originalOpcode !== 0x000e) {
              dexBuffer.writeUInt16LE(0x000e, codeItemOff + 16);
              patched = true;
              const signature = `${className}->${methodName}()${returnType || 'V'}`;
              patchedMethods.push(signature);
              logger.info(
                `[dexPatch] Neutralized ${signature} with return-void (was 0x${originalOpcode.toString(16).padStart(4, '0')})`,
              );
            }
          }
        }
      }
    };

    inspectMethods(numDirectMethods.value);
    inspectMethods(numVirtualMethods.value);
  }

  if (patched) {
    updateDexChecksums(dexBuffer);
  }

  return { patched, patchedMethods };
}
