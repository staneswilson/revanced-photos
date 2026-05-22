const TYPE_HEADER = 0x0003;
const TYPE_STRING_POOL = 0x0001;
const TYPE_RESOURCE_MAP = 0x0180;
const TYPE_XML_ELEMENT_START = 0x0102;

const FLAG_UTF8 = 0x100;

const RES_ID_EXTRACT_NATIVE_LIBS = 0x010104ea;
const ANDROID_NS_URI = 'http://schemas.android.com/apk/res/android';
const ATTR_NAME = 'extractNativeLibs';

const DATA_TYPE_BOOLEAN = 0x12;

const STRING_POOL_HEADER_SIZE = 28;
const RESOURCE_MAP_HEADER_SIZE = 8;
const ATTRIBUTE_ENTRY_SIZE = 20;

export class AxmlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AxmlEditError';
  }
}

interface StringPool {
  strings: string[];
  isUtf8: boolean;
  flags: number;
  chunkOffset: number;
  chunkSize: number;
  headerSize: number;
  stringsStart: number;
  stylesStart: number;
}

interface ResourceMap {
  ids: number[];
  chunkOffset: number;
  chunkSize: number;
  headerSize: number;
}

function readStringPool(buf: Buffer, offset: number): StringPool {
  const type = buf.readUInt16LE(offset);
  if (type !== TYPE_STRING_POOL) {
    throw new AxmlEditError(
      `Expected string pool at 0x${offset.toString(16)}, got type 0x${type.toString(16)}`,
    );
  }
  const headerSize = buf.readUInt16LE(offset + 2);
  const chunkSize = buf.readUInt32LE(offset + 4);
  const stringCount = buf.readUInt32LE(offset + 8);
  const flags = buf.readUInt32LE(offset + 16);
  const stringsStart = buf.readUInt32LE(offset + 20);
  const stylesStart = buf.readUInt32LE(offset + 24);
  const isUtf8 = (flags & FLAG_UTF8) !== 0;

  const strings: string[] = [];
  for (let i = 0; i < stringCount; i++) {
    const strRef = buf.readUInt32LE(offset + headerSize + i * 4);
    let p = offset + stringsStart + strRef;
    if (isUtf8) {
      let charLen = buf.readUInt8(p);
      p += 1;
      if (charLen & 0x80) {
        charLen = ((charLen & 0x7f) << 8) | buf.readUInt8(p);
        p += 1;
      }
      let byteLen = buf.readUInt8(p);
      p += 1;
      if (byteLen & 0x80) {
        byteLen = ((byteLen & 0x7f) << 8) | buf.readUInt8(p);
        p += 1;
      }
      strings.push(buf.subarray(p, p + byteLen).toString('utf8'));
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

  return {
    strings,
    isUtf8,
    flags,
    chunkOffset: offset,
    chunkSize,
    headerSize,
    stringsStart,
    stylesStart,
  };
}

function readResourceMap(buf: Buffer, offset: number): ResourceMap {
  const type = buf.readUInt16LE(offset);
  if (type !== TYPE_RESOURCE_MAP) {
    throw new AxmlEditError(
      `Expected resource map at 0x${offset.toString(16)}, got type 0x${type.toString(16)}`,
    );
  }
  const headerSize = buf.readUInt16LE(offset + 2);
  const chunkSize = buf.readUInt32LE(offset + 4);
  const idCount = (chunkSize - headerSize) / 4;
  const ids: number[] = [];
  for (let i = 0; i < idCount; i++) {
    ids.push(buf.readUInt32LE(offset + headerSize + i * 4));
  }
  return { ids, chunkOffset: offset, chunkSize, headerSize };
}

function encodeUtf16String(s: string): Buffer {
  const charLen = s.length;
  const chars = Buffer.from(s, 'utf16le');
  if (charLen >= 0x8000) {
    throw new AxmlEditError(`UTF-16 string too long: ${charLen}`);
  }
  const out = Buffer.alloc(2 + chars.length + 2);
  out.writeUInt16LE(charLen, 0);
  chars.copy(out, 2);
  out.writeUInt16LE(0, 2 + chars.length);
  return out;
}

function encodeUtf8String(s: string): Buffer {
  const chars = [...s];
  const charLen = chars.length;
  const bytes = Buffer.from(s, 'utf8');
  if (charLen >= 0x8000 || bytes.length >= 0x8000) {
    throw new AxmlEditError(`UTF-8 string too long: chars=${charLen} bytes=${bytes.length}`);
  }
  const headerLen = (charLen >= 0x80 ? 2 : 1) + (bytes.length >= 0x80 ? 2 : 1);
  const out = Buffer.alloc(headerLen + bytes.length + 1);
  let p = 0;
  if (charLen >= 0x80) {
    out.writeUInt8(((charLen >> 8) & 0x7f) | 0x80, p++);
    out.writeUInt8(charLen & 0xff, p++);
  } else {
    out.writeUInt8(charLen, p++);
  }
  if (bytes.length >= 0x80) {
    out.writeUInt8(((bytes.length >> 8) & 0x7f) | 0x80, p++);
    out.writeUInt8(bytes.length & 0xff, p++);
  } else {
    out.writeUInt8(bytes.length, p++);
  }
  bytes.copy(out, p);
  out.writeUInt8(0, p + bytes.length);
  return out;
}

function rebuildStringPool(strings: string[], isUtf8: boolean, flags: number): Buffer {
  const offsets: number[] = [];
  const dataChunks: Buffer[] = [];
  let dataLen = 0;
  for (const s of strings) {
    offsets.push(dataLen);
    const enc = isUtf8 ? encodeUtf8String(s) : encodeUtf16String(s);
    dataChunks.push(enc);
    dataLen += enc.length;
  }
  const dataPaddedLen = (dataLen + 3) & ~3;
  const padding = dataPaddedLen - dataLen;
  const offsetsLen = offsets.length * 4;
  const stringsStart = STRING_POOL_HEADER_SIZE + offsetsLen;
  const chunkSize = stringsStart + dataPaddedLen;

  const out = Buffer.alloc(chunkSize);
  out.writeUInt16LE(TYPE_STRING_POOL, 0);
  out.writeUInt16LE(STRING_POOL_HEADER_SIZE, 2);
  out.writeUInt32LE(chunkSize, 4);
  out.writeUInt32LE(strings.length, 8);
  out.writeUInt32LE(0, 12);
  out.writeUInt32LE(flags, 16);
  out.writeUInt32LE(stringsStart, 20);
  out.writeUInt32LE(0, 24);
  for (let i = 0; i < offsets.length; i++) {
    out.writeUInt32LE(offsets[i]!, STRING_POOL_HEADER_SIZE + i * 4);
  }
  let p = stringsStart;
  for (const chunk of dataChunks) {
    chunk.copy(out, p);
    p += chunk.length;
  }
  for (let i = 0; i < padding; i++) {
    out.writeUInt8(0, p + i);
  }
  return out;
}

function rebuildResourceMap(ids: number[]): Buffer {
  const chunkSize = RESOURCE_MAP_HEADER_SIZE + ids.length * 4;
  const out = Buffer.alloc(chunkSize);
  out.writeUInt16LE(TYPE_RESOURCE_MAP, 0);
  out.writeUInt16LE(RESOURCE_MAP_HEADER_SIZE, 2);
  out.writeUInt32LE(chunkSize, 4);
  for (let i = 0; i < ids.length; i++) {
    out.writeUInt32LE(ids[i]!, RESOURCE_MAP_HEADER_SIZE + i * 4);
  }
  return out;
}

interface ElementChunk {
  offset: number;
  chunkSize: number;
  headerSize: number;
  namespaceRef: number;
  nameRef: number;
  attributeStart: number;
  attributeSize: number;
  attributeCount: number;
}

function readElementChunk(buf: Buffer, offset: number): ElementChunk {
  const type = buf.readUInt16LE(offset);
  if (type !== TYPE_XML_ELEMENT_START) {
    throw new AxmlEditError(
      `Expected element start at 0x${offset.toString(16)}, got 0x${type.toString(16)}`,
    );
  }
  return {
    offset,
    headerSize: buf.readUInt16LE(offset + 2),
    chunkSize: buf.readUInt32LE(offset + 4),
    namespaceRef: buf.readUInt32LE(offset + 16),
    nameRef: buf.readUInt32LE(offset + 20),
    attributeStart: buf.readUInt16LE(offset + 24),
    attributeSize: buf.readUInt16LE(offset + 26),
    attributeCount: buf.readUInt16LE(offset + 28),
  };
}

function findFirstElement(
  buf: Buffer,
  startOffset: number,
  fileEnd: number,
  name: string,
  strings: string[],
): ElementChunk | null {
  let p = startOffset;
  while (p < fileEnd) {
    const type = buf.readUInt16LE(p);
    const chunkSize = buf.readUInt32LE(p + 4);
    if (chunkSize <= 0 || p + chunkSize > fileEnd) {
      throw new AxmlEditError(`Invalid chunk size ${chunkSize} at 0x${p.toString(16)}`);
    }
    if (type === TYPE_XML_ELEMENT_START) {
      const el = readElementChunk(buf, p);
      if (el.nameRef < strings.length && strings[el.nameRef] === name) {
        return el;
      }
    }
    p += chunkSize;
  }
  return null;
}

export interface ApplicationAttributes {
  hasExtractNativeLibs: boolean;
  extractNativeLibsValue: boolean | null;
}

export function inspectExtractNativeLibs(buf: Buffer): ApplicationAttributes {
  if (buf.readUInt16LE(0) !== TYPE_HEADER) {
    throw new AxmlEditError('Not a binary AXML file');
  }
  const fileSize = buf.readUInt32LE(4);
  const sp = readStringPool(buf, 8);
  const rm = readResourceMap(buf, sp.chunkOffset + sp.chunkSize);
  const xmlStart = rm.chunkOffset + rm.chunkSize;

  const appEl = findFirstElement(buf, xmlStart, fileSize, 'application', sp.strings);
  if (!appEl) {
    return { hasExtractNativeLibs: false, extractNativeLibsValue: null };
  }
  const extractNativeLibsStringIdx = sp.strings.indexOf(ATTR_NAME);
  if (extractNativeLibsStringIdx < 0) {
    return { hasExtractNativeLibs: false, extractNativeLibsValue: null };
  }
  const attrsStart = appEl.offset + appEl.headerSize + appEl.attributeStart;
  for (let i = 0; i < appEl.attributeCount; i++) {
    const attrOff = attrsStart + i * appEl.attributeSize;
    const nameRef = buf.readUInt32LE(attrOff + 4);
    if (nameRef !== extractNativeLibsStringIdx) continue;
    if (nameRef < rm.ids.length && rm.ids[nameRef] !== RES_ID_EXTRACT_NATIVE_LIBS) continue;
    const data = buf.readUInt32LE(attrOff + 16);
    return { hasExtractNativeLibs: true, extractNativeLibsValue: data !== 0 };
  }
  return { hasExtractNativeLibs: false, extractNativeLibsValue: null };
}

export function setExtractNativeLibsFalse(buf: Buffer): Buffer {
  if (buf.readUInt16LE(0) !== TYPE_HEADER) {
    throw new AxmlEditError('Not a binary AXML file');
  }
  const fileSize = buf.readUInt32LE(4);
  if (fileSize !== buf.length) {
    throw new AxmlEditError(`AXML header file size ${fileSize} != buffer length ${buf.length}`);
  }

  const sp = readStringPool(buf, 8);
  const rm = readResourceMap(buf, sp.chunkOffset + sp.chunkSize);
  const xmlStart = rm.chunkOffset + rm.chunkSize;

  const androidNsIdx = sp.strings.indexOf(ANDROID_NS_URI);
  if (androidNsIdx < 0) {
    throw new AxmlEditError(`Android namespace URI not found in string pool`);
  }

  const appEl = findFirstElement(buf, xmlStart, fileSize, 'application', sp.strings);
  if (!appEl) {
    throw new AxmlEditError('No <application> element found in manifest');
  }

  let attrNameIdx = sp.strings.indexOf(ATTR_NAME);
  let falseIdx = sp.strings.indexOf('false');

  const attrsStart = appEl.offset + appEl.headerSize + appEl.attributeStart;
  let existingAttrOffsetInChunk = -1;
  if (attrNameIdx >= 0) {
    for (let i = 0; i < appEl.attributeCount; i++) {
      const attrOff = attrsStart + i * appEl.attributeSize;
      const nameRef = buf.readUInt32LE(attrOff + 4);
      if (nameRef === attrNameIdx) {
        existingAttrOffsetInChunk = attrOff - appEl.offset;
        break;
      }
    }
  }

  const newStrings = sp.strings.slice();
  const newIds = rm.ids.slice();

  if (attrNameIdx < 0) {
    attrNameIdx = newStrings.length;
    newStrings.push(ATTR_NAME);
  }
  if (falseIdx < 0) {
    falseIdx = newStrings.length;
    newStrings.push('false');
  }
  while (newIds.length <= attrNameIdx) {
    newIds.push(0);
  }
  newIds[attrNameIdx] = RES_ID_EXTRACT_NATIVE_LIBS;

  const newStringPool = rebuildStringPool(newStrings, sp.isUtf8, sp.flags);
  const newResourceMap = rebuildResourceMap(newIds);

  let newAppChunk: Buffer;
  if (existingAttrOffsetInChunk >= 0) {
    newAppChunk = Buffer.from(buf.subarray(appEl.offset, appEl.offset + appEl.chunkSize));
    const attrOffInNew = existingAttrOffsetInChunk;
    newAppChunk.writeUInt32LE(0xffffffff, attrOffInNew);
    newAppChunk.writeUInt32LE(attrNameIdx, attrOffInNew + 4);
    newAppChunk.writeUInt32LE(falseIdx, attrOffInNew + 8);
    newAppChunk.writeUInt16LE(8, attrOffInNew + 12);
    newAppChunk.writeUInt8(0, attrOffInNew + 14);
    newAppChunk.writeUInt8(DATA_TYPE_BOOLEAN, attrOffInNew + 15);
    newAppChunk.writeUInt32LE(0, attrOffInNew + 16);
  } else {
    const newAttr = Buffer.alloc(ATTRIBUTE_ENTRY_SIZE);
    newAttr.writeUInt32LE(androidNsIdx, 0);
    newAttr.writeUInt32LE(attrNameIdx, 4);
    newAttr.writeUInt32LE(falseIdx, 8);
    newAttr.writeUInt16LE(8, 12);
    newAttr.writeUInt8(0, 14);
    newAttr.writeUInt8(DATA_TYPE_BOOLEAN, 15);
    newAttr.writeUInt32LE(0, 16);

    const existingAttrsEnd = attrsStart - appEl.offset + appEl.attributeCount * appEl.attributeSize;
    newAppChunk = Buffer.alloc(appEl.chunkSize + ATTRIBUTE_ENTRY_SIZE);
    buf.copy(newAppChunk, 0, appEl.offset, appEl.offset + existingAttrsEnd);
    newAttr.copy(newAppChunk, existingAttrsEnd);
    buf.copy(
      newAppChunk,
      existingAttrsEnd + ATTRIBUTE_ENTRY_SIZE,
      appEl.offset + existingAttrsEnd,
      appEl.offset + appEl.chunkSize,
    );

    newAppChunk.writeUInt32LE(appEl.chunkSize + ATTRIBUTE_ENTRY_SIZE, 4);
    newAppChunk.writeUInt16LE(appEl.attributeCount + 1, 28);
  }

  const headBeforeStringPool = buf.subarray(0, 8);
  const beforeApp = buf.subarray(xmlStart, appEl.offset);
  const afterApp = buf.subarray(appEl.offset + appEl.chunkSize, fileSize);

  const newFileSize =
    headBeforeStringPool.length +
    newStringPool.length +
    newResourceMap.length +
    beforeApp.length +
    newAppChunk.length +
    afterApp.length;

  const out = Buffer.alloc(newFileSize);
  let p = 0;
  headBeforeStringPool.copy(out, p);
  p += headBeforeStringPool.length;
  newStringPool.copy(out, p);
  p += newStringPool.length;
  newResourceMap.copy(out, p);
  p += newResourceMap.length;
  beforeApp.copy(out, p);
  p += beforeApp.length;
  newAppChunk.copy(out, p);
  p += newAppChunk.length;
  afterApp.copy(out, p);

  out.writeUInt16LE(TYPE_HEADER, 0);
  out.writeUInt16LE(8, 2);
  out.writeUInt32LE(newFileSize, 4);

  return out;
}
