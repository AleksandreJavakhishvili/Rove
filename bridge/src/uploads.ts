import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const IMAGE_MIME = /^image\//i;

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap — keeps the phone from hanging.

export interface SavedUpload {
  /** Absolute path on disk. */
  absPath: string;
  /** Path relative to the session cwd, suitable for passing into a user message. */
  relPath: string;
  sizeBytes: number;
  isImage: boolean;
  mimeType: string;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'upload.bin';
}

/**
 * Save an uploaded blob under <cwd>/.rove/uploads/<ts>-<safeName>. The path is
 * always inside cwd (so the agent's Read tool can access it) but quarantined
 * to a single dot-directory the user can git-ignore.
 */
export async function saveUpload(opts: {
  cwd: string;
  fileName: string;
  mimeType?: string;
  data: Buffer | Uint8Array;
}): Promise<SavedUpload> {
  if (opts.data.byteLength > MAX_BYTES) {
    throw new Error(`upload too large (${opts.data.byteLength} bytes, max ${MAX_BYTES})`);
  }
  const cwd = resolve(opts.cwd);
  const dir = join(cwd, '.rove', 'uploads');
  await mkdir(dir, { recursive: true });

  const fname = `${Date.now()}-${safeName(opts.fileName)}`;
  const abs = join(dir, fname);

  // Defense-in-depth: ensure abs is inside cwd.
  if (abs !== cwd && !abs.startsWith(cwd + sep)) {
    throw new Error('upload path escaped cwd');
  }

  await writeFile(abs, Buffer.from(opts.data));
  const rel = abs.slice(cwd.length + 1);
  const isImage =
    (opts.mimeType ? IMAGE_MIME.test(opts.mimeType) : false) || IMAGE_EXT.test(opts.fileName);
  return {
    absPath: abs,
    relPath: rel,
    sizeBytes: opts.data.byteLength,
    isImage,
    mimeType: opts.mimeType ?? (isImage ? 'image/*' : 'application/octet-stream'),
  };
}
