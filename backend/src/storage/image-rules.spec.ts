import {
  checkDeclaredUpload,
  formatFromContentType,
  formatFromFileName,
  MAX_IMAGE_BYTES,
  PRESIGNED_GET_TTL_SECONDS,
  PRESIGNED_POST_TTL_SECONDS,
} from './image-rules.js';

describe('image rules', () => {
  it('fixes the agreed limits', () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(PRESIGNED_POST_TTL_SECONDS).toBe(300);
    expect(PRESIGNED_GET_TTL_SECONDS).toBe(60);
  });

  it.each([
    ['image/jpeg', 'jpeg'],
    ['IMAGE/PNG', 'png'],
    [' image/webp ', 'webp'],
    ['image/jpg', null], // not a registered type
    ['image/gif', null],
    ['image/svg+xml', null],
    ['text/html', null],
    ['image/png; charset=utf-8', null],
    ['', null],
  ])('formatFromContentType(%j) = %j', (ct, expected) => {
    expect(formatFromContentType(ct)).toBe(expected);
  });

  it.each([
    ['dish.jpg', 'jpeg'],
    ['DISH.JPEG', 'jpeg'],
    ['logo.png', 'png'],
    ['me.webp', 'webp'],
    ['photo.png.exe', null],
    ['photo.exe.png', 'png'],
    ['noextension', null],
    ['.png', 'png'],
    ['image.gif', null],
    ['image.svg', null],
    ['x.jpg ', 'jpeg'],
  ])('formatFromFileName(%j) = %j', (name, expected) => {
    expect(formatFromFileName(name)).toBe(expected);
  });

  describe('checkDeclaredUpload (T16, T17 pre-checks)', () => {
    const ok = { fileName: 'dish.png', contentType: 'image/png', size: 1000 };

    it('accepts JPG, PNG and WebP within 5 MB', () => {
      expect(checkDeclaredUpload(ok)).toEqual({ ok: true, format: 'png' });
      expect(checkDeclaredUpload({ fileName: 'a.jpeg', contentType: 'image/jpeg', size: MAX_IMAGE_BYTES })).toEqual({ ok: true, format: 'jpeg' });
      expect(checkDeclaredUpload({ fileName: 'a.webp', contentType: 'image/webp', size: 1 })).toEqual({ ok: true, format: 'webp' });
    });

    it.each([
      [{ size: MAX_IMAGE_BYTES + 1 }, 'TOO_LARGE'],
      [{ size: 0 }, 'EMPTY'],
      [{ size: -1 }, 'INVALID_SIZE'],
      [{ size: 1.5 }, 'INVALID_SIZE'],
      [{ size: Number.NaN }, 'INVALID_SIZE'],
      [{ fileName: 'a.gif', contentType: 'image/gif' }, 'UNSUPPORTED_TYPE'],
      [{ fileName: 'a.svg', contentType: 'image/svg+xml' }, 'UNSUPPORTED_TYPE'],
      [{ fileName: 'a.html', contentType: 'text/html' }, 'UNSUPPORTED_TYPE'],
      [{ fileName: 'a.png', contentType: 'image/jpeg' }, 'TYPE_MISMATCH'],
    ])('rejects %o with %s', (override, reason) => {
      expect(checkDeclaredUpload({ ...ok, ...override })).toEqual({ ok: false, reason });
    });
  });
});
