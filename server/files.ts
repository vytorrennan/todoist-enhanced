import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { ApiFailure, type Db, newId, nowIso } from './db';
import type { UserRow } from './auth';

/**
 * Files people attach to comments. Stored on disk under the data directory,
 * named by their id, and recorded in the database with their owner. A file is
 * served to its owner, and to anyone who can see a comment that carries it.
 */

export const MAX_UPLOAD_BYTES = Number(process.env.TDE_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

/** Types that would run as a page on this origin are never served as themselves. */
const RUNNABLE = /html|svg|xml|javascript|ecmascript/i;

export function filesDir(dataDir: string): string {
  const dir = join(dataDir, 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StoredFile {
  id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  file_url: string;
  resource_type: string;
  upload_state: string;
}

/** Writes an uploaded file to disk, then records it. A file over the limit is removed again. */
/** Forgets an upload: its row and its bytes. Used when a request is refused after the file was written. */
export function removeUpload(db: Db, dataDir: string, fileId: string): void {
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  rmSync(join(filesDir(dataDir), fileId), { force: true });
}

export async function storeUpload(
  db: Db,
  dataDir: string,
  owner: UserRow,
  input: { name: string; type: string; body: Readable; maxBytes?: number; check?: () => void },
): Promise<StoredFile> {
  const id = newId();
  const path = join(filesDir(dataDir), id);
  try {
    await pipeline(input.body, createWriteStream(path, { flags: 'wx' }));
  } catch (error) {
    rmSync(path, { force: true });
    throw ApiFailure.badRequest(`The file could not be saved: ${(error as Error).message}`, 'UPLOAD_FAILED');
  }
  const bytes = statSync(path).size;
  if (bytes > (input.maxBytes ?? MAX_UPLOAD_BYTES)) {
    rmSync(path, { force: true });
    throw new ApiFailure(413, 'That file is too large for this server.', 'FILE_TOO_LARGE');
  }
  // The caller's last word before the row is kept: a file that is no longer wanted leaves nothing behind.
  try {
    input.check?.();
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
  const fileName = input.name.replace(/[\r\n"\\]/g, '').slice(0, 200) || 'file';
  const fileType = input.type && /^[\w.+-]+\/[\w.+-]+$/.test(input.type) ? input.type : 'application/octet-stream';
  db.prepare(`INSERT INTO files (id, owner_id, file_name, file_type, file_size, storage_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, owner.id, fileName, fileType, bytes, id, nowIso());
  return {
    id,
    file_name: fileName,
    file_type: fileType,
    file_size: bytes,
    file_url: `/api/v1/files/${id}`,
    resource_type: fileType.startsWith('image/') ? 'image' : 'file',
    upload_state: 'completed',
  };
}

export interface ServedFile {
  path: string;
  name: string;
  type: string;
  size: number;
}

/** The file, if this person may have it: they uploaded it, or can see a comment that carries it. */
export function fileFor(db: Db, dataDir: string, viewerId: string, fileId: string): ServedFile {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as
    | { id: string; owner_id: string; file_name: string; file_type: string; file_size: number; storage_name: string } | undefined;
  if (!row) throw ApiFailure.notFound('That file does not exist.', 'FILE_NOT_FOUND');
  // The attachment's own address, compared exactly: a file name can contain anything, including another file's address.
  const allowed = row.owner_id === viewerId || db.prepare(`
      SELECT 1 FROM notes n
      LEFT JOIN items i ON i.id = n.item_id
      WHERE n.is_deleted = 0 AND json_extract(n.file_attachment, '$.file_url') = @url
        AND (
          (n.item_id IS NOT NULL AND i.is_deleted = 0 AND i.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active'))
          OR (n.item_id IS NULL AND n.project_id IN (SELECT project_id FROM project_members WHERE user_id = @viewer AND state = 'active'))
        )
      LIMIT 1`).get({ url: `/api/v1/files/${row.id}`, viewer: viewerId }) !== undefined;
  if (!allowed) throw ApiFailure.notFound('That file does not exist.', 'FILE_NOT_FOUND');
  const path = join(filesDir(dataDir), row.storage_name);
  if (!existsSync(path)) throw ApiFailure.notFound('That file is no longer here.', 'FILE_NOT_FOUND');
  return {
    path,
    name: row.file_name,
    type: RUNNABLE.test(row.file_type) ? 'application/octet-stream' : row.file_type,
    size: row.file_size,
  };
}

