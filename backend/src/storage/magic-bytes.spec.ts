import {
  gifFile,
  htmlFile,
  pngHeaderThenGarbage,
  svgFile,
  textFile,
  truncate,
  validJpeg,
  validPng,
  validWebp,
} from '../../test/fixtures/images.js';
import { detectImageFormat, HEAD_BYTES, inspectImageBytes, TAIL_BYTES } from './magic-bytes.js';

/** Mimics what the verifier reads from S3: first 16 and last 32 bytes. */
const inspect = (b: Buffer) =>
  inspectImageBytes({ head: b.subarray(0, HEAD_BYTES), tail: b.subarray(Math.max(0, b.length - TAIL_BYTES)), size: b.length });

describe('magic bytes — basic file-type verification (not full image validation)', () => {
  it.each([
    ['PNG', validPng(), 'png'],
    ['JPEG', validJpeg(), 'jpeg'],
    ['WebP', validWebp(), 'webp'],
  ])('accepts a well-formed %s', (_, bytes, format) => {
    expect(inspect(bytes)).toEqual({ ok: true, format });
  });

  it('accepts a JPEG with a little padding after the EOI marker', () => {
    expect(inspect(Buffer.concat([validJpeg(), Buffer.alloc(8, 0)]))).toEqual({ ok: true, format: 'jpeg' });
  });

  describe('unsupported or fake content (T17, T18)', () => {
    it.each([
      ['plain text', textFile()],
      ['HTML with script', htmlFile()],
      ['SVG with onload', svgFile()],
      ['GIF', gifFile()],
      ['all zeros', Buffer.alloc(100)],
      ['empty', Buffer.alloc(0)],
    ])('rejects %s', (_, bytes) => {
      expect(inspect(bytes)).toEqual({ ok: false, reason: 'UNRECOGNISED_SIGNATURE' });
    });

    it('rejects a PNG signature without an IHDR chunk', () => {
      const b = validPng();
      b.write('XXXX', 12, 'ascii');
      expect(inspect(b)).toEqual({ ok: false, reason: 'UNRECOGNISED_SIGNATURE' });
    });

    it('rejects RIFF files that are not WebP (e.g. WAV)', () => {
      const b = validWebp();
      b.write('WAVE', 8, 'ascii');
      expect(inspect(b)).toEqual({ ok: false, reason: 'UNRECOGNISED_SIGNATURE' });
    });

    it('rejects "FF D8 FF FF" (not a valid JPEG marker)', () => {
      const b = validJpeg();
      b[3] = 0xff;
      expect(detectImageFormat(b.subarray(0, HEAD_BYTES))).toBeNull();
    });
  });

  describe('corrupted / truncated images (T18)', () => {
    it.each([
      ['PNG cut in half', truncate(validPng(), 40)],
      ['PNG missing IEND', truncate(validPng(), validPng().length - 12)],
      ['PNG header followed by garbage', pngHeaderThenGarbage()],
      ['JPEG without EOI', truncate(validJpeg(), validJpeg().length - 2)],
      ['JPEG cut early', truncate(validJpeg(200), 60)],
      ['WebP truncated (RIFF size too big)', truncate(validWebp(), validWebp().length - 4)],
      ['WebP with trailing data (RIFF size too small)', Buffer.concat([validWebp(), Buffer.alloc(4)])],
    ])('rejects %s', (_, bytes) => {
      expect(inspect(bytes)).toEqual({ ok: false, reason: 'TRUNCATED_OR_CORRUPT' });
    });

    it('only needs the first 16 and last 32 bytes, whatever the file size', () => {
      expect(HEAD_BYTES).toBe(16);
      expect(TAIL_BYTES).toBe(32);
    });
  });

  it('does NOT detect a mismatch by itself: a PNG is a PNG regardless of its name (caller compares formats)', () => {
    expect(inspect(validPng())).toEqual({ ok: true, format: 'png' });
  });
});
