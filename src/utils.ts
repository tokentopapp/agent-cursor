import { Database } from 'bun:sqlite';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  CursorBubbleData,
  CursorComposerData,
  CursorWorkspaceComposerIndex,
  CursorWorkspaceJson,
} from './types.ts';

export function openDatabase(dbPath: string): Database | null {
  try {
    return new Database(dbPath, { readonly: true, create: false });
  } catch {
    return null;
  }
}

/**
 * Open a database WITHOUT readonly mode. Used by the activity watcher to
 * avoid WAL snapshot isolation — bun:sqlite in readonly mode may not see
 * rows that exist only in the WAL file (not yet checkpointed).
 * Read-write connections in WAL mode always read the latest WAL state.
 */
export function openDatabaseForWatcher(dbPath: string): Database | null {
  try {
    return new Database(dbPath, { readwrite: true, create: false });
  } catch {
    return null;
  }
}

export function readComposerData(db: Database, composerId: string): CursorComposerData | null {
  try {
    const row = db.query('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`) as { value: string } | null;
    if (!row) return null;
    return JSON.parse(row.value) as CursorComposerData;
  } catch {
    return null;
  }
}

export function readBubbleData(db: Database, composerId: string, bubbleId: string): CursorBubbleData | null {
  try {
    const row = db.query('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${composerId}:${bubbleId}`) as { value: string } | null;
    if (!row) return null;
    return JSON.parse(row.value) as CursorBubbleData;
  } catch {
    return null;
  }
}

export function readAllComposerIds(db: Database): string[] {
  try {
    const PREFIX = 'composerData:';
    const rows = db.query("SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Array<{ key: string }>;
    return rows.map((row) => row.key.slice(PREFIX.length));
  } catch {
    return [];
  }
}

export function readAllBubbleKeys(db: Database, composerId: string): string[] {
  try {
    const PREFIX = `bubbleId:${composerId}:`;
    const rows = db.query('SELECT key FROM cursorDiskKV WHERE key LIKE ?').all(`bubbleId:${composerId}:%`) as Array<{ key: string }>;
    return rows.map((row) => row.key.slice(PREFIX.length));
  } catch {
    return [];
  }
}

export function readWorkspaceComposerIndex(workspaceDirPath: string): CursorWorkspaceComposerIndex | null {
  const dbPath = path.join(workspaceDirPath, 'state.vscdb');
  const db = openDatabase(dbPath);
  if (!db) return null;

  try {
    const row = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get() as { value: string } | null;
    if (!row) return null;
    return JSON.parse(row.value) as CursorWorkspaceComposerIndex;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function readWorkspaceJson(workspaceDirPath: string): Promise<CursorWorkspaceJson | null> {
  try {
    const content = await fs.readFile(path.join(workspaceDirPath, 'workspace.json'), 'utf-8');
    return JSON.parse(content) as CursorWorkspaceJson;
  } catch {
    return null;
  }
}

export function parseWorkspaceFolderUri(folderUri: string): string {
  if (folderUri.startsWith('file://')) {
    try {
      return decodeURIComponent(folderUri.slice(7));
    } catch {
      return folderUri.slice(7);
    }
  }
  return folderUri;
}

export function resolveProviderId(modelName: string): string {
  const lower = modelName.toLowerCase();

  if (lower.startsWith('claude')) return 'anthropic';
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.startsWith('chatgpt') || lower.includes('codex')) return 'openai';
  if (lower.startsWith('gemini')) return 'google';
  if (lower.startsWith('deepseek')) return 'deepseek';

  return 'cursor';
}
