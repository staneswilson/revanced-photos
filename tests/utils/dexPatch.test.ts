import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  adler32,
  readUleb128,
  isValidDex,
  updateDexChecksums,
  patchGmsCoreSupportDex,
} from '../../src/utils/dexPatch.js';

/**
 * Helper to construct a minimal valid DEX binary structure in memory.
 */
function createSyntheticDex(options: {
  strings: string[];
  types: number[]; // indexes into strings
  methods: { classIdx: number; protoIdx: number; nameIdx: number }[];
  classDefs: {
    classIdx: number;
    methods: { methodIdx: number; accessFlags: number; insns: number[] }[];
  }[];
}): Buffer {
  // We'll build string data, string IDs, type IDs, method IDs, class defs, class data, and code items
  const chunks: { [key: string]: Buffer } = {};

  // 1. String data
  const stringOffsets: number[] = [];
  const stringDataBuffers: Buffer[] = [];
  let currentStringDataOffset = 0;

  for (const s of options.strings) {
    stringOffsets.push(currentStringDataOffset);
    const strBuf = Buffer.from(s, 'utf8');
    // ULEB128 length followed by MUTF-8 string and null terminator
    const ulebLen = Buffer.from([s.length]);
    const nullTerm = Buffer.from([0]);
    const fullStr = Buffer.concat([ulebLen, strBuf, nullTerm]);
    stringDataBuffers.push(fullStr);
    currentStringDataOffset += fullStr.length;
  }
  chunks.stringData = Buffer.concat(stringDataBuffers);

  // 2. String IDs (each uint32 offset)
  const stringIdsBuf = Buffer.alloc(options.strings.length * 4);
  chunks.stringIds = stringIdsBuf;

  // 3. Type IDs (each uint32 descriptor_idx)
  const typeIdsBuf = Buffer.alloc(options.types.length * 4);
  for (let i = 0; i < options.types.length; i++) {
    typeIdsBuf.writeUInt32LE(options.types[i]!, i * 4);
  }
  chunks.typeIds = typeIdsBuf;

  // 4. Method IDs (uint16 class_idx, uint16 proto_idx, uint32 name_idx)
  const methodIdsBuf = Buffer.alloc(options.methods.length * 8);
  for (let i = 0; i < options.methods.length; i++) {
    const m = options.methods[i]!;
    methodIdsBuf.writeUInt16LE(m.classIdx, i * 8);
    methodIdsBuf.writeUInt16LE(m.protoIdx, i * 8 + 2);
    methodIdsBuf.writeUInt32LE(m.nameIdx, i * 8 + 4);
  }
  chunks.methodIds = methodIdsBuf;

  // Layout calculation
  const headerSize = 0x70; // 112 bytes
  const stringIdsOff = headerSize;
  const typeIdsOff = stringIdsOff + chunks.stringIds.length;
  const methodIdsOff = typeIdsOff + chunks.typeIds.length;
  const classDefsOff = methodIdsOff + chunks.methodIds.length;
  const classDefsSize = options.classDefs.length;
  const classDefsLen = classDefsSize * 32;

  let currentDataOff = classDefsOff + classDefsLen;

  // Fix string IDs offsets
  const stringDataOffStart = currentDataOff;
  for (let i = 0; i < options.strings.length; i++) {
    stringIdsBuf.writeUInt32LE(stringDataOffStart + stringOffsets[i]!, i * 4);
  }
  currentDataOff += chunks.stringData.length;

  // Build code items and class data
  const classDefBuffers: Buffer[] = [];
  const extraDataBuffers: Buffer[] = [];

  for (const c of options.classDefs) {
    const classDataStartOff = currentDataOff;
    const classDataParts: Buffer[] = [];

    // static_fields_size (0), instance_fields_size (0), direct_methods_size (count), virtual_methods_size (0)
    classDataParts.push(Buffer.from([0])); // static
    classDataParts.push(Buffer.from([0])); // instance
    classDataParts.push(Buffer.from([c.methods.length])); // direct
    classDataParts.push(Buffer.from([0])); // virtual

    // Pre-calculate code items
    const codeItemBuffers: Buffer[] = [];
    for (const m of c.methods) {
      const codeItemBuf = Buffer.alloc(16 + m.insns.length * 2);
      codeItemBuf.writeUInt16LE(1, 0); // registers_size
      codeItemBuf.writeUInt16LE(0, 2); // ins_size
      codeItemBuf.writeUInt16LE(0, 4); // outs_size
      codeItemBuf.writeUInt16LE(0, 6); // tries_size
      codeItemBuf.writeUInt32LE(0, 8); // debug_info_off
      codeItemBuf.writeUInt32LE(m.insns.length, 12); // insns_size
      for (let i = 0; i < m.insns.length; i++) {
        codeItemBuf.writeUInt16LE(m.insns[i]!, 16 + i * 2);
      }
      codeItemBuffers.push(codeItemBuf);
    }

    // Class data size
    const classDataBytesLen = 4 + c.methods.length * 4;

    let codeItemStart = classDataStartOff + classDataBytesLen;
    // Align code item to 4 bytes if needed
    if (codeItemStart % 4 !== 0) {
      codeItemStart += 4 - (codeItemStart % 4);
    }

    let lastMethodIdx = 0;
    let runningCodeItemOff = codeItemStart;
    for (let i = 0; i < c.methods.length; i++) {
      const m = c.methods[i]!;
      const diff = m.methodIdx - lastMethodIdx;
      lastMethodIdx = m.methodIdx;

      classDataParts.push(Buffer.from([diff]));
      classDataParts.push(Buffer.from([m.accessFlags]));

      // code_off as 2-byte ULEB
      const codeOff = runningCodeItemOff;
      const b1 = (codeOff & 0x7f) | 0x80;
      const b2 = (codeOff >> 7) & 0x7f;
      classDataParts.push(Buffer.from([b1, b2]));

      runningCodeItemOff += codeItemBuffers[i]!.length;
    }

    const fullClassData = Buffer.concat(classDataParts);
    extraDataBuffers.push(fullClassData);
    currentDataOff += fullClassData.length;

    // Pad for 4-byte code_item alignment
    if (currentDataOff % 4 !== 0) {
      const pad = Buffer.alloc(4 - (currentDataOff % 4));
      extraDataBuffers.push(pad);
      currentDataOff += pad.length;
    }

    for (const cb of codeItemBuffers) {
      extraDataBuffers.push(cb);
      currentDataOff += cb.length;
    }

    // Class def entry (32 bytes)
    const classDefBuf = Buffer.alloc(32);
    classDefBuf.writeUInt32LE(c.classIdx, 0); // class_idx
    classDefBuf.writeUInt32LE(1, 4); // access_flags
    classDefBuf.writeUInt32LE(0, 8); // superclass_idx
    classDefBuf.writeUInt32LE(0, 12); // interfaces_off
    classDefBuf.writeUInt32LE(0, 16); // source_file_idx
    classDefBuf.writeUInt32LE(0, 20); // annotations_off
    classDefBuf.writeUInt32LE(classDataStartOff, 24); // class_data_off
    classDefBuf.writeUInt32LE(0, 28); // static_values_off
    classDefBuffers.push(classDefBuf);
  }

  const classDefsBuf = Buffer.concat(classDefBuffers);
  const dataSectionBuf = Buffer.concat([chunks.stringData, ...extraDataBuffers]);

  const totalFileSize =
    headerSize +
    chunks.stringIds.length +
    chunks.typeIds.length +
    chunks.methodIds.length +
    classDefsBuf.length +
    dataSectionBuf.length;

  const headerBuf = Buffer.alloc(headerSize);
  headerBuf.write('dex\n035\0', 0, 8, 'ascii');
  headerBuf.writeUInt32LE(totalFileSize, 32); // file_size
  headerBuf.writeUInt32LE(headerSize, 36); // header_size
  headerBuf.writeUInt32LE(0x12345678, 40); // endian_tag

  headerBuf.writeUInt32LE(options.strings.length, 56); // string_ids_size
  headerBuf.writeUInt32LE(stringIdsOff, 60); // string_ids_off

  headerBuf.writeUInt32LE(options.types.length, 64); // type_ids_size
  headerBuf.writeUInt32LE(typeIdsOff, 68); // type_ids_off

  headerBuf.writeUInt32LE(0, 72); // proto_ids_size
  headerBuf.writeUInt32LE(0, 76); // proto_ids_off

  headerBuf.writeUInt32LE(0, 80); // field_ids_size
  headerBuf.writeUInt32LE(0, 84); // field_ids_off

  headerBuf.writeUInt32LE(options.methods.length, 88); // method_ids_size
  headerBuf.writeUInt32LE(methodIdsOff, 92); // method_ids_off

  headerBuf.writeUInt32LE(classDefsSize, 96); // class_defs_size
  headerBuf.writeUInt32LE(classDefsOff, 100); // class_defs_off

  headerBuf.writeUInt32LE(dataSectionBuf.length, 104); // data_size
  headerBuf.writeUInt32LE(stringDataOffStart, 108); // data_off

  const fullDex = Buffer.concat([
    headerBuf,
    chunks.stringIds,
    chunks.typeIds,
    chunks.methodIds,
    classDefsBuf,
    dataSectionBuf,
  ]);

  updateDexChecksums(fullDex);
  return fullDex;
}

describe('dexPatch', () => {
  it('correctly calculates Adler32 checksums', () => {
    const testData = Buffer.from('Wikipedia', 'utf8');
    // Wikipedia adler32 is 0x11E60398
    const sum = adler32(testData);
    expect(sum).toBe(0x11e60398);
  });

  it('correctly reads ULEB128 values', () => {
    // 0x00 -> 0
    expect(readUleb128(Buffer.from([0x00]), 0)).toEqual({
      value: 0,
      bytesRead: 1,
    });
    // 0x01 -> 1
    expect(readUleb128(Buffer.from([0x01]), 0)).toEqual({
      value: 1,
      bytesRead: 1,
    });
    // 0x80, 0x01 -> 128
    expect(readUleb128(Buffer.from([0x80, 0x01]), 0)).toEqual({
      value: 128,
      bytesRead: 2,
    });
    // 0xff, 0x7f -> 16383
    expect(readUleb128(Buffer.from([0xff, 0x7f]), 0)).toEqual({
      value: 16383,
      bytesRead: 2,
    });
  });

  it('validates DEX magic bytes', () => {
    const valid = Buffer.alloc(112);
    valid.write('dex\n035\0', 0, 8, 'ascii');
    expect(isValidDex(valid)).toBe(true);

    const valid039 = Buffer.alloc(112);
    valid039.write('dex\n039\0', 0, 8, 'ascii');
    expect(isValidDex(valid039)).toBe(true);

    const invalid = Buffer.from('not a dex file');
    expect(isValidDex(invalid)).toBe(false);
  });

  it('updates SHA-1 and Adler32 checksums in DEX header', () => {
    const buf = Buffer.alloc(112);
    buf.write('dex\n035\0', 0, 8, 'ascii');
    updateDexChecksums(buf);

    // Verify SHA-1
    const expectedSha1 = crypto.createHash('sha1').update(buf.subarray(32)).digest();
    expect(buf.subarray(12, 32).equals(expectedSha1)).toBe(true);

    // Verify Adler32
    const expectedAdler = adler32(buf.subarray(12));
    expect(buf.readUInt32LE(8)).toBe(expectedAdler);
  });

  it('ignores DEX files that do not contain GmsCoreSupport', () => {
    const dex = createSyntheticDex({
      strings: ['Lcom/example/MyClass;', 'doSomething', 'Ljava/lang/Object;', '()V'],
      types: [0, 2],
      methods: [{ classIdx: 0, protoIdx: 0, nameIdx: 1 }],
      classDefs: [
        {
          classIdx: 0,
          methods: [
            {
              methodIdx: 0,
              accessFlags: 1,
              insns: [0x1234, 0x5678], // dummy instructions
            },
          ],
        },
      ],
    });

    const result = patchGmsCoreSupportDex(dex);
    expect(result.patched).toBe(false);
    expect(result.patchedMethods).toHaveLength(0);
  });

  it('finds and neutralizes checkUpdates in GmsCoreSupport class with return-void (0x000E)', () => {
    const dex = createSyntheticDex({
      strings: [
        'Lapp/revanced/extension/shared/GmsCoreSupport$GmsCore;',
        'checkUpdates',
        'Ljava/lang/Object;',
        '()V',
      ],
      types: [0, 2],
      methods: [{ classIdx: 0, protoIdx: 0, nameIdx: 1 }],
      classDefs: [
        {
          classIdx: 0,
          methods: [
            {
              methodIdx: 0,
              accessFlags: 9, // public static
              insns: [0x6e10, 0x0001, 0x0000], // invoke-static dummy
            },
          ],
        },
      ],
    });

    const result = patchGmsCoreSupportDex(dex);
    expect(result.patched).toBe(true);
    expect(result.patchedMethods).toContain(
      'Lapp/revanced/extension/shared/GmsCoreSupport$GmsCore;->checkUpdates()V',
    );

    // Verify checksum was updated
    const expectedSha1 = crypto.createHash('sha1').update(dex.subarray(32)).digest();
    expect(dex.subarray(12, 32).equals(expectedSha1)).toBe(true);
    expect(dex.readUInt32LE(8)).toBe(adler32(dex.subarray(12)));
  });
});
