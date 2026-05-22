import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  inspectExtractNativeLibs,
  setExtractNativeLibsFalse,
  AxmlEditError,
} from '../../src/utils/axml.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'photos-AndroidManifest.xml');

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const RES_ID_EXTRACT_NATIVE_LIBS = 0x010104ea;

const TYPE_HEADER = 0x0003;
const TYPE_STRING_POOL = 0x0001;
const TYPE_RESOURCE_MAP = 0x0180;
const TYPE_XML_NS_START = 0x0100;
const TYPE_XML_NS_END = 0x0101;
const TYPE_XML_ELEMENT_START = 0x0102;
const TYPE_XML_ELEMENT_END = 0x0103;

function readStringPool(buf: Buffer, off: number) {
  const headerSize = buf.readUInt16LE(off + 2);
  const chunkSize = buf.readUInt32LE(off + 4);
  const stringCount = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const isUtf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const ref = buf.readUInt32LE(off + headerSize + i * 4);
    let p = off + stringsStart + ref;
    if (isUtf8) {
      let cl = buf.readUInt8(p);
      p++;
      if (cl & 0x80) {
        cl = ((cl & 0x7f) << 8) | buf.readUInt8(p);
        p++;
      }
      let bl = buf.readUInt8(p);
      p++;
      if (bl & 0x80) {
        bl = ((bl & 0x7f) << 8) | buf.readUInt8(p);
        p++;
      }
      strings.push(buf.subarray(p, p + bl).toString('utf8'));
    } else {
      let len = buf.readUInt16LE(p);
      p += 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p);
        p += 2;
      }
      strings.push(buf.subarray(p, p + len * 2).toString('utf16le'));
    }
  }
  return { strings, chunkSize, isUtf8 };
}

function walkChunks(buf: Buffer): Array<{ type: number; offset: number; size: number }> {
  const sp = buf.readUInt32LE(8 + 4);
  let p = 8 + sp;
  const rmSize = buf.readUInt32LE(p + 4);
  p += rmSize;
  const chunks: Array<{ type: number; offset: number; size: number }> = [];
  while (p < buf.length) {
    const type = buf.readUInt16LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) {
      throw new Error(`corrupt chunk at 0x${p.toString(16)} size=${size}`);
    }
    chunks.push({ type, offset: p, size });
    p += size;
  }
  return chunks;
}

function findApplicationElement(buf: Buffer): {
  offset: number;
  headerSize: number;
  chunkSize: number;
  attrStart: number;
  attrSize: number;
  attrCount: number;
  attrBase: number;
  strings: string[];
} {
  const sp = readStringPool(buf, 8);
  const rmOff = 8 + sp.chunkSize;
  const rmChunkSize = buf.readUInt32LE(rmOff + 4);
  let p = rmOff + rmChunkSize;
  while (p < buf.length) {
    const type = buf.readUInt16LE(p);
    const cSize = buf.readUInt32LE(p + 4);
    if (type === TYPE_XML_ELEMENT_START) {
      const nameRef = buf.readUInt32LE(p + 20);
      if (sp.strings[nameRef] === 'application') {
        const headerSize = buf.readUInt16LE(p + 2);
        return {
          offset: p,
          headerSize,
          chunkSize: cSize,
          attrStart: buf.readUInt16LE(p + 24),
          attrSize: buf.readUInt16LE(p + 26),
          attrCount: buf.readUInt16LE(p + 28),
          attrBase: p + headerSize + buf.readUInt16LE(p + 24),
          strings: sp.strings,
        };
      }
    }
    p += cSize;
  }
  throw new Error('application element not found');
}

describe('axml editor — inspectExtractNativeLibs', () => {
  it('returns hasExtractNativeLibs=false when string absent (stock Photos manifest)', () => {
    const buf = fs.readFileSync(FIXTURE);
    const result = inspectExtractNativeLibs(buf);
    expect(result.hasExtractNativeLibs).toBe(false);
    expect(result.extractNativeLibsValue).toBeNull();
  });

  it('throws AxmlEditError on a non-AXML buffer', () => {
    expect(() => inspectExtractNativeLibs(Buffer.from('not-an-axml-file'))).toThrowError(
      AxmlEditError,
    );
  });
});

describe('axml editor — setExtractNativeLibsFalse (insertion path)', () => {
  const original = fs.readFileSync(FIXTURE);
  const modified = setExtractNativeLibsFalse(original);

  it('produces a buffer whose AXML file header records its own length', () => {
    expect(modified.readUInt16LE(0)).toBe(TYPE_HEADER);
    expect(modified.readUInt32LE(4)).toBe(modified.length);
  });

  it('round-trips: inspect on output reports extractNativeLibs=false', () => {
    const result = inspectExtractNativeLibs(modified);
    expect(result.hasExtractNativeLibs).toBe(true);
    expect(result.extractNativeLibsValue).toBe(false);
  });

  it('appends new strings without touching existing ones', () => {
    const before = readStringPool(original, 8);
    const after = readStringPool(modified, 8);
    expect(after.strings.length).toBe(before.strings.length + 2);
    for (let i = 0; i < before.strings.length; i++) {
      expect(after.strings[i]).toBe(before.strings[i]);
    }
    expect(after.strings[before.strings.length]).toBe('extractNativeLibs');
    expect(after.strings[before.strings.length + 1]).toBe('false');
    expect(after.isUtf8).toBe(before.isUtf8);
  });

  it('extends resource map so id[extractNativeLibsIdx] = 0x010104ea', () => {
    const before = readStringPool(original, 8);
    const extractIdx = before.strings.length;
    const rmOff = 8 + readStringPool(modified, 8).chunkSize;
    const rmHeaderSize = modified.readUInt16LE(rmOff + 2);
    const rmChunkSize = modified.readUInt32LE(rmOff + 4);
    const idCount = (rmChunkSize - rmHeaderSize) / 4;
    expect(idCount).toBeGreaterThanOrEqual(extractIdx + 1);
    expect(modified.readUInt32LE(rmOff + rmHeaderSize + extractIdx * 4)).toBe(
      RES_ID_EXTRACT_NATIVE_LIBS,
    );
  });

  it('appends extractNativeLibs as the last application attribute with boolean false', () => {
    const before = findApplicationElement(original);
    const after = findApplicationElement(modified);
    expect(after.attrCount).toBe(before.attrCount + 1);
    expect(after.chunkSize).toBe(before.chunkSize + 20);
    const newAttrOff = after.attrBase + (after.attrCount - 1) * after.attrSize;
    const ns = modified.readUInt32LE(newAttrOff);
    const name = modified.readUInt32LE(newAttrOff + 4);
    const rawValue = modified.readInt32LE(newAttrOff + 8);
    const size = modified.readUInt16LE(newAttrOff + 12);
    const dataType = modified.readUInt8(newAttrOff + 15);
    const data = modified.readUInt32LE(newAttrOff + 16);
    expect(after.strings[ns]).toBe(ANDROID_NS);
    expect(after.strings[name]).toBe('extractNativeLibs');
    expect(after.strings[rawValue]).toBe('false');
    expect(size).toBe(8);
    expect(dataType).toBe(0x12);
    expect(data).toBe(0);
  });

  it('walks every chunk from header to EOF without corruption', () => {
    const chunks = walkChunks(modified);
    const elementStarts = chunks.filter((c) => c.type === TYPE_XML_ELEMENT_START).length;
    const elementEnds = chunks.filter((c) => c.type === TYPE_XML_ELEMENT_END).length;
    const nsStarts = chunks.filter((c) => c.type === TYPE_XML_NS_START).length;
    const nsEnds = chunks.filter((c) => c.type === TYPE_XML_NS_END).length;
    expect(elementStarts).toBe(elementEnds);
    expect(nsStarts).toBe(nsEnds);
    expect(elementStarts).toBeGreaterThan(0);
  });

  it('leaves the manifest element attribute count unchanged', () => {
    const sp = readStringPool(modified, 8);
    const rmOff = 8 + sp.chunkSize;
    const rmChunkSize = modified.readUInt32LE(rmOff + 4);
    let p = rmOff + rmChunkSize;
    while (p < modified.length) {
      const type = modified.readUInt16LE(p);
      const cSize = modified.readUInt32LE(p + 4);
      if (type === TYPE_XML_ELEMENT_START) {
        const nameRef = modified.readUInt32LE(p + 20);
        if (sp.strings[nameRef] === 'manifest') {
          expect(modified.readUInt16LE(p + 28)).toBe(8);
          return;
        }
      }
      p += cSize;
    }
    throw new Error('manifest element not found');
  });
});

describe('axml editor — setExtractNativeLibsFalse (modify-existing path)', () => {
  function buildSyntheticManifestWithExtractTrue(): Buffer {
    const strings = ['manifest', 'application', ANDROID_NS, 'android', 'extractNativeLibs', 'true'];
    const stringEntries: Buffer[] = strings.map((s) => {
      const chars = Buffer.from(s, 'utf16le');
      const out = Buffer.alloc(2 + chars.length + 2);
      out.writeUInt16LE(s.length, 0);
      chars.copy(out, 2);
      out.writeUInt16LE(0, 2 + chars.length);
      return out;
    });
    const offsets: number[] = [];
    let total = 0;
    for (const e of stringEntries) {
      offsets.push(total);
      total += e.length;
    }
    const padded = (total + 3) & ~3;
    const stringsStart = 28 + strings.length * 4;
    const spSize = stringsStart + padded;
    const sp = Buffer.alloc(spSize);
    sp.writeUInt16LE(TYPE_STRING_POOL, 0);
    sp.writeUInt16LE(28, 2);
    sp.writeUInt32LE(spSize, 4);
    sp.writeUInt32LE(strings.length, 8);
    sp.writeUInt32LE(0, 12);
    sp.writeUInt32LE(0, 16);
    sp.writeUInt32LE(stringsStart, 20);
    sp.writeUInt32LE(0, 24);
    for (let i = 0; i < offsets.length; i++) {
      sp.writeUInt32LE(offsets[i]!, 28 + i * 4);
    }
    let p = stringsStart;
    for (const e of stringEntries) {
      e.copy(sp, p);
      p += e.length;
    }

    const ids = new Array(4).fill(0);
    ids.push(RES_ID_EXTRACT_NATIVE_LIBS);
    ids.push(0);
    const rm = Buffer.alloc(8 + ids.length * 4);
    rm.writeUInt16LE(TYPE_RESOURCE_MAP, 0);
    rm.writeUInt16LE(8, 2);
    rm.writeUInt32LE(rm.length, 4);
    for (let i = 0; i < ids.length; i++) {
      rm.writeUInt32LE(ids[i], 8 + i * 4);
    }

    const nsStart = Buffer.alloc(24);
    nsStart.writeUInt16LE(TYPE_XML_NS_START, 0);
    nsStart.writeUInt16LE(16, 2);
    nsStart.writeUInt32LE(24, 4);
    nsStart.writeUInt32LE(1, 8);
    nsStart.writeUInt32LE(0xffffffff, 12);
    nsStart.writeUInt32LE(3, 16);
    nsStart.writeUInt32LE(2, 20);

    function makeElement(nameIdx: number, attrs: Buffer[]): Buffer {
      const headerAndAttrExt = 36;
      const size = headerAndAttrExt + attrs.length * 20;
      const out = Buffer.alloc(size);
      out.writeUInt16LE(TYPE_XML_ELEMENT_START, 0);
      out.writeUInt16LE(16, 2);
      out.writeUInt32LE(size, 4);
      out.writeUInt32LE(1, 8);
      out.writeUInt32LE(0xffffffff, 12);
      out.writeUInt32LE(0xffffffff, 16);
      out.writeUInt32LE(nameIdx, 20);
      out.writeUInt16LE(20, 24);
      out.writeUInt16LE(20, 26);
      out.writeUInt16LE(attrs.length, 28);
      out.writeUInt16LE(0, 30);
      out.writeUInt16LE(0, 32);
      out.writeUInt16LE(0, 34);
      let q = 36;
      for (const a of attrs) {
        a.copy(out, q);
        q += 20;
      }
      return out;
    }

    function makeAttr(
      ns: number,
      name: number,
      rawValue: number,
      dt: number,
      data: number,
    ): Buffer {
      const out = Buffer.alloc(20);
      out.writeUInt32LE(ns, 0);
      out.writeUInt32LE(name, 4);
      out.writeUInt32LE(rawValue, 8);
      out.writeUInt16LE(8, 12);
      out.writeUInt8(0, 14);
      out.writeUInt8(dt, 15);
      out.writeUInt32LE(data, 16);
      return out;
    }

    const manifestEl = makeElement(0, []);
    const applicationEl = makeElement(1, [makeAttr(2, 4, 5, 0x12, 0xffffffff)]);

    function makeElementEnd(nameIdx: number): Buffer {
      const out = Buffer.alloc(24);
      out.writeUInt16LE(TYPE_XML_ELEMENT_END, 0);
      out.writeUInt16LE(16, 2);
      out.writeUInt32LE(24, 4);
      out.writeUInt32LE(1, 8);
      out.writeUInt32LE(0xffffffff, 12);
      out.writeUInt32LE(0xffffffff, 16);
      out.writeUInt32LE(nameIdx, 20);
      return out;
    }
    const applicationEnd = makeElementEnd(1);
    const manifestEnd = makeElementEnd(0);

    const nsEnd = Buffer.alloc(24);
    nsEnd.writeUInt16LE(TYPE_XML_NS_END, 0);
    nsEnd.writeUInt16LE(16, 2);
    nsEnd.writeUInt32LE(24, 4);
    nsEnd.writeUInt32LE(1, 8);
    nsEnd.writeUInt32LE(0xffffffff, 12);
    nsEnd.writeUInt32LE(3, 16);
    nsEnd.writeUInt32LE(2, 20);

    const body = Buffer.concat([
      sp,
      rm,
      nsStart,
      manifestEl,
      applicationEl,
      applicationEnd,
      manifestEnd,
      nsEnd,
    ]);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(TYPE_HEADER, 0);
    header.writeUInt16LE(8, 2);
    header.writeUInt32LE(8 + body.length, 4);
    return Buffer.concat([header, body]);
  }

  it('flips an existing extractNativeLibs=true attribute to false without growing the chunk', () => {
    const original = buildSyntheticManifestWithExtractTrue();
    const before = inspectExtractNativeLibs(original);
    expect(before.hasExtractNativeLibs).toBe(true);
    expect(before.extractNativeLibsValue).toBe(true);

    const modified = setExtractNativeLibsFalse(original);
    const after = inspectExtractNativeLibs(modified);
    expect(after.hasExtractNativeLibs).toBe(true);
    expect(after.extractNativeLibsValue).toBe(false);

    const beforeApp = findApplicationElement(original);
    const afterApp = findApplicationElement(modified);
    expect(afterApp.attrCount).toBe(beforeApp.attrCount);
    expect(afterApp.chunkSize).toBe(beforeApp.chunkSize);
  });
});
