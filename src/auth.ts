import { Database } from 'bun:sqlite';
import { CURSOR_STATE_DB_PATH } from './paths.ts';
import { openDatabase } from './utils.ts';

/**
 * Reads a value from the ItemTable in Cursor's global state database.
 * ItemTable stores auth tokens, settings, and other key-value data
 * separate from the cursorDiskKV table used for composer/bubble data.
 */
function readItemTableValue(db: Database, key: string): string | null {
  try {
    const row = db.query('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Decodes a JWT payload without signature verification.
 * We only need the claims (specifically `sub` for the user ID) — no
 * verification needed since we're reading our own locally-stored token.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;

    // Base64url → standard Base64
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Reads the Cursor access token from local SQLite and constructs the
 * WorkosCursorSessionToken cookie needed for Cursor's dashboard API.
 *
 * Cookie format: `WorkosCursorSessionToken={userId}%3A%3A{accessToken}`
 * where userId is the JWT `sub` claim (e.g. "google-oauth2|user_01K...").
 *
 * Returns null if credentials are unavailable or malformed.
 */
export function buildSessionCookie(): string | null {
  const db = openDatabase(CURSOR_STATE_DB_PATH);
  if (!db) return null;

  try {
    const accessToken = readItemTableValue(db, 'cursorAuth/accessToken');
    if (!accessToken) return null;

    const payload = decodeJwtPayload(accessToken);
    if (!payload || typeof payload.sub !== 'string') return null;

    const userId = payload.sub;
    return `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`;
  } finally {
    db.close();
  }
}
