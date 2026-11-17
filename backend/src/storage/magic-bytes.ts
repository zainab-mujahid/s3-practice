/**
 * File signature ("magic bytes") checks for JPEG, PNG and WebP.
 *
 * IMPORTANT — this is BASIC file-type verification, not image validation.
 * It proves that the first and last bytes of the object look like the claimed
 * format and that the container is not obviously truncated. It does NOT:
 *   - decode the image or prove that the pixel data is valid,
 *   - detect polyglot files (valid image header + something else inside),
 *   - strip metadata (EXIF GPS location, comments),
 *   - protect against decoder exploits ("image bombs", malformed chunks).
 * Production systems re-encode uploads with a hardened image library in an
 * isolated worker (or use a managed scanning service) before publishing them.
 * In this app the browser only ever renders the object as an <img> with a
 * server-set image/* Content-Type, which limits what a crafted file can do.
 */
import type { ImageFormat } from './image-rules.js';

/** Bytes read from the start of the object (range GET bytes=0-15). */
export const HEAD_BYTES = 16;
/** Bytes read from the end of the object (range GET bytes=-32). */
export const TAIL_BYTES = 32;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// The first PNG chunk must be IHDR with a data length of 13.
const PNG_IHDR = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
// A complete PNG ends with an empty IEND chunk: length 0, "IEND", CRC AE426082.
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

const ascii = (s: string) => Array.from(Buffer.from(s, 'ascii'));
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const WEBP_CHUNKS = [ascii('VP8 '), ascii('VP8L'), ascii('VP8X')];

function startsWithAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((b, i) => bytes[offset + i] === b);
}

function endsWith(bytes: Uint8Array, expected: readonly number[]): boolean {
  return startsWithAt(bytes, bytes.length - expected.length, expected);
}

/** Identifies the format from the first HEAD_BYTES bytes, or null if unrecognised. */
export function detectImageFormat(head: Uint8Array): ImageFormat | null {
  // JPEG: SOI marker FF D8 followed by another marker (FF xx, xx in C0..FE).
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff && head[3] >= 0xc0 && head[3] !== 0xff) {
    return 'jpeg';
  }
  if (startsWithAt(head, 0, PNG_SIGNATURE) && startsWithAt(head, 8, PNG_IHDR)) return 'png';
  if (startsWithAt(head, 0, RIFF) && startsWithAt(head, 8, WEBP) && WEBP_CHUNKS.some((c) => startsWithAt(head, 12, c))) {
    return 'webp';
  }
  return null;
}

/**
 * Cheap end-of-file / container checks that catch truncated uploads:
 *   JPEG — an EOI marker (FF D9) within the last TAIL_BYTES bytes (tolerates a little padding).
 *   PNG  — the file ends exactly with the IEND chunk.
 *   WebP — the RIFF size field equals the object size minus 8.
 */
export function hasValidStructure(format: ImageFormat, head: Uint8Array, tail: Uint8Array, totalSize: number): boolean {
  switch (format) {
    case 'jpeg':
      for (let i = tail.length - 2; i >= 0; i--) {
        if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
      }
      return false;
    case 'png':
      return endsWith(tail, PNG_IEND);
    case 'webp': {
      if (head.length < 8) return false;
      const riffSize = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
      return riffSize + 8 === totalSize;
    }
  }
}

export type ImageInspection =
  | { ok: true; format: ImageFormat }
  | { ok: false; reason: 'UNRECOGNISED_SIGNATURE' | 'TRUNCATED_OR_CORRUPT' };

export function inspectImageBytes(input: { head: Uint8Array; tail: Uint8Array; size: number }): ImageInspection {
  const format = detectImageFormat(input.head);
  if (!format) return { ok: false, reason: 'UNRECOGNISED_SIGNATURE' };
  if (!hasValidStructure(format, input.head, input.tail, input.size)) return { ok: false, reason: 'TRUNCATED_OR_CORRUPT' };
  return { ok: true, format };
}
