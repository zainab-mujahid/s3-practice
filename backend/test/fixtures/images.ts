/**
 * Byte-level image fixtures generated in code (no binary files in the repo).
 * PNG is a real, decodable 1x1 image; JPEG/WebP have correct signatures and
 * container structure (enough for the basic checks in magic-bytes.ts).
 */
import { crc32, deflateSync } from 'node:zlib';

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A genuine 1x1 RGBA PNG. */
export function validPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.from([0, 0xff, 0x00, 0x00, 0xff]); // filter byte + one red pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG: SOI, JFIF APP0 segment, filler, EOI. */
export function validJpeg(fillerBytes = 64): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.alloc(fillerBytes, 0x11), Buffer.from([0xff, 0xd9])]);
}

/** WebP (lossless): RIFF header with the correct size field, WEBP, VP8L chunk. */
export function validWebp(payloadBytes = 40): Buffer {
  const chunkHeader = Buffer.concat([Buffer.from('VP8L', 'ascii'), Buffer.alloc(4)]);
  chunkHeader.writeUInt32LE(payloadBytes, 4);
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunkHeader, Buffer.alloc(payloadBytes, 0x2f)]);
  const riff = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4)]);
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

export const textFile = () => Buffer.from('This is plain text pretending to be an image file.\n'.repeat(2));
export const htmlFile = () => Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
export const svgFile = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
export const gifFile = () => Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(40, 0)]);

/** Cuts a file short (simulates an interrupted / corrupted upload). */
export const truncate = (b: Buffer, keep: number) => b.subarray(0, keep);

/** A valid image signature followed by unrelated content (polyglot-style). */
export const pngHeaderThenGarbage = () => Buffer.concat([validPng().subarray(0, 33), Buffer.alloc(64, 0x41)]);
