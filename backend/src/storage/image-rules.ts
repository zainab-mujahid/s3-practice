/**
 * Image upload rules shared by every upload flow (Steps 4 and 5).
 *
 * These checks run on what the CLIENT declares before an upload URL is issued.
 * They are a convenience/early rejection only: the authoritative checks happen
 * after upload, on the actual S3 object (see object-verifier.ts), because a
 * client can lie about its file name, type and size.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface ImageFormatInfo {
  /** The only Content-Type the object will be stored with. */
  contentType: string;
  /** Canonical extension used in server-generated object keys. */
  extension: 'jpg' | 'png' | 'webp';
  /** File-name extensions accepted from the client (lower-case). */
  acceptedExtensions: readonly string[];
}

export const IMAGE_FORMATS: Readonly<Record<ImageFormat, ImageFormatInfo>> = Object.freeze({
  jpeg: { contentType: 'image/jpeg', extension: 'jpg', acceptedExtensions: ['jpg', 'jpeg'] },
  png: { contentType: 'image/png', extension: 'png', acceptedExtensions: ['png'] },
  webp: { contentType: 'image/webp', extension: 'webp', acceptedExtensions: ['webp'] },
});

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (5 MiB)
/** Smaller than any meaningful image; also guarantees the signature bytes exist. */
export const MIN_IMAGE_BYTES = 32;

/** Presigned POST (upload) validity — used from Step 4. */
export const PRESIGNED_POST_TTL_SECONDS = 300;
/** Presigned GET (private picture view) validity — used from Step 5. */
export const PRESIGNED_GET_TTL_SECONDS = 60;

export type DeclaredUploadRejection = 'UNSUPPORTED_TYPE' | 'TYPE_MISMATCH' | 'EMPTY' | 'TOO_LARGE' | 'INVALID_SIZE';

export type DeclaredUploadCheck = { ok: true; format: ImageFormat } | { ok: false; reason: DeclaredUploadRejection };

/** Exact, case-insensitive match against the allow-list. No parameters (e.g. "; charset=") allowed. */
export function formatFromContentType(contentType: string): ImageFormat | null {
  const ct = contentType.trim().toLowerCase();
  for (const [format, info] of Object.entries(IMAGE_FORMATS) as [ImageFormat, ImageFormatInfo][]) {
    if (info.contentType === ct) return format;
  }
  return null;
}

/** Uses only the LAST extension, so "photo.png.exe" and "photo.exe.png" are judged by ".exe" / ".png". */
export function formatFromFileName(fileName: string): ImageFormat | null {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim());
  if (!match) return null;
  const ext = match[1].toLowerCase();
  for (const [format, info] of Object.entries(IMAGE_FORMATS) as [ImageFormat, ImageFormatInfo][]) {
    if (info.acceptedExtensions.includes(ext)) return format;
  }
  return null;
}

/** Pre-upload check of the client's declaration (file name, MIME type, size). */
export function checkDeclaredUpload(input: { fileName: string; contentType: string; size: number }): DeclaredUploadCheck {
  if (!Number.isSafeInteger(input.size) || input.size < 0) return { ok: false, reason: 'INVALID_SIZE' };
  if (input.size === 0) return { ok: false, reason: 'EMPTY' };
  if (input.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'TOO_LARGE' };

  const byType = formatFromContentType(input.contentType);
  const byName = formatFromFileName(input.fileName);
  if (!byType || !byName) return { ok: false, reason: 'UNSUPPORTED_TYPE' };
  if (byType !== byName) return { ok: false, reason: 'TYPE_MISMATCH' };
  return { ok: true, format: byType };
}
