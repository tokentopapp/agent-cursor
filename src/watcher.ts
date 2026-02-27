import * as fsSync from 'fs';
import type { ActivityCallback, ActivityUpdate } from '@tokentop/plugin-sdk';
import { estimateOutputTokens } from './parser.ts';
import { CURSOR_STATE_DB_PATH } from './paths.ts';
import { openDatabaseForWatcher } from './utils.ts';

export interface SessionWatcherState {
  watchers: fsSync.FSWatcher[];
  dirty: boolean;
  reconciliationTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

interface ActivityWatcherState {
  watchers: fsSync.FSWatcher[];
  callback: ActivityCallback | null;
  /** Rowid-based cursor: only rows with rowid > lastBubbleRowId are "new". */
  lastBubbleRowId: number;
  /** Assistant bubbles seen with empty text/zero tokens — re-checked each poll. */
  pendingBubbles: Map<string, { composerId: string; bubbleId: string }>;
  pollTimer: ReturnType<typeof setInterval> | null;
  pendingPollTimer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher: SessionWatcherState = {
  watchers: [],
  dirty: false,
  reconciliationTimer: null,
  started: false,
};

const activityWatcher: ActivityWatcherState = {
  watchers: [],
  callback: null,
  lastBubbleRowId: 0,
  pendingBubbles: new Map(),
  pollTimer: null,
  pendingPollTimer: null,
  debounceTimer: null,
  started: false,
};

export let forceFullReconciliation = false;

const ASSISTANT_BUBBLE_TYPE = 2;

function toTimestamp(isoString: string | undefined): number {
  if (!isoString) return Date.now();
  const parsed = Date.parse(isoString);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Extracts the composerId from a bubble key like `bubbleId:{composerId}:{bubbleId}`.
 */
function extractComposerId(key: string): string {
  // key format: bubbleId:{composerId}:{bubbleId}
  const firstColon = key.indexOf(':');
  const secondColon = key.indexOf(':', firstColon + 1);
  return key.slice(firstColon + 1, secondColon);
}

/**
 * Extracts the bubbleId from a bubble key like `bubbleId:{composerId}:{bubbleId}`.
 */
function extractBubbleId(key: string): string {
  const firstColon = key.indexOf(':');
  const secondColon = key.indexOf(':', firstColon + 1);
  return key.slice(secondColon + 1);
}

/**
 * Initialize the rowid cursor to the current max rowid of bubble keys.
 * This ensures we only detect bubbles created AFTER the watcher starts.
 */
function initializeRowIdCursor(): void {
  const db = openDatabaseForWatcher(CURSOR_STATE_DB_PATH);
  if (!db) {
    return;
  }

  try {
    const row = db.query(
      "SELECT MAX(rowid) as maxRowId FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
    ).get() as { maxRowId: number | null } | null;
    activityWatcher.lastBubbleRowId = row?.maxRowId ?? 0;
  } finally {
    db.close();
  }
}

/**
 * Attempt to fire the callback for an assistant bubble.
 * Returns true if the callback was fired (bubble had content), false if still pending.
 */
function tryFireBubble(
  db: ReturnType<typeof openDatabaseForWatcher>,
  composerId: string,
  bubbleId: string,
  callback: ActivityCallback,
): boolean {
  if (!db) return false;

  const row = db.query('SELECT value FROM cursorDiskKV WHERE key = ?').get(
    `bubbleId:${composerId}:${bubbleId}`,
  ) as { value: string } | null;
  if (!row) return false;

  let bubble: Record<string, unknown>;
  try {
    bubble = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return false;
  }

  if (bubble.type !== ASSISTANT_BUBBLE_TYPE) return true; // not assistant, done

  const tc = bubble.tokenCount as { inputTokens?: number; outputTokens?: number } | undefined;
  const hasRealTokens = (tc && typeof tc.inputTokens === 'number' && tc.inputTokens > 0)
    || (tc && typeof tc.outputTokens === 'number' && tc.outputTokens > 0);
  const outputTokens = hasRealTokens && tc ? tc.outputTokens ?? 0 : estimateOutputTokens(bubble.text as string | undefined);
  const inputTokens = hasRealTokens && tc ? tc.inputTokens ?? 0 : 0;

  if (inputTokens === 0 && outputTokens === 0) return false; // still empty

  const tokens: ActivityUpdate['tokens'] = {
    input: inputTokens,
    output: outputTokens,
  };

  callback({
    sessionId: composerId,
    messageId: typeof bubble.bubbleId === 'string' ? bubble.bubbleId : bubbleId,
    tokens,
    timestamp: toTimestamp(bubble.createdAt as string | undefined),
  });
  return true;
}

/**
 * Rowid-based cursor scan for new bubble rows, plus re-check of pending bubbles.
 *
 * Cursor writes assistant bubbles in two phases:
 *   1. INSERT with empty text and zero tokens (new rowid — detected by cursor)
 *   2. UPDATE with actual content (same rowid — missed by cursor alone)
 *
 * To handle phase 2, we track empty assistant bubbles in a "pending" set and
 * re-read them by key on each poll until they have content.
 */
function processDbChange(): void {
  const callback = activityWatcher.callback;
  if (!callback) return;

  const db = openDatabaseForWatcher(CURSOR_STATE_DB_PATH);
  if (!db) return;

  try {
    // Phase 1: Check for new rows via rowid cursor
    const rows = db.query(
      "SELECT rowid, key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND rowid > ? ORDER BY rowid ASC",
    ).all(activityWatcher.lastBubbleRowId) as Array<{ rowid: number; key: string; value: string }>;

    for (const row of rows) {
      activityWatcher.lastBubbleRowId = row.rowid;
      sessionWatcher.dirty = true;

      let bubble: Record<string, unknown>;
      try {
        bubble = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Skip non-assistant bubbles entirely
      if (bubble.type !== ASSISTANT_BUBBLE_TYPE) continue;

      const composerId = extractComposerId(row.key);
      const bubbleId = typeof bubble.bubbleId === 'string' ? bubble.bubbleId : extractBubbleId(row.key);

      // Try to fire immediately — if bubble has content already
      if (!tryFireBubble(db, composerId, bubbleId, callback)) {
        // No content yet (streaming/empty) — add to pending for re-check
        const pendingKey = `${composerId}:${bubbleId}`;
        activityWatcher.pendingBubbles.set(pendingKey, { composerId, bubbleId });
      }
    }

    // Phase 2: Re-check pending bubbles for content updates
    if (activityWatcher.pendingBubbles.size > 0) {
      const resolved: string[] = [];
      for (const [pendingKey, { composerId, bubbleId }] of activityWatcher.pendingBubbles) {
        if (tryFireBubble(db, composerId, bubbleId, callback)) {
          resolved.push(pendingKey);
        }
      }
      for (const key of resolved) {
        activityWatcher.pendingBubbles.delete(key);
      }
    }

    // Schedule fast re-check if pending bubbles remain (Cursor is still streaming).
    // Once all pending are resolved, the fast timer naturally stops.
    if (activityWatcher.pendingBubbles.size > 0 && !activityWatcher.pendingPollTimer) {
      activityWatcher.pendingPollTimer = setTimeout(() => {
        activityWatcher.pendingPollTimer = null;
        processDbChange();
      }, PENDING_POLL_MS);
    } else if (activityWatcher.pendingBubbles.size === 0 && activityWatcher.pendingPollTimer) {
      clearTimeout(activityWatcher.pendingPollTimer);
      activityWatcher.pendingPollTimer = null;
    }
  } catch {
  } finally {
    db.close();
  }
}

export function startSessionWatcher(): void {
  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  // Watch both the main DB file and the WAL file. SQLite in WAL mode
  // writes to state.vscdb-wal, so fs.watch on the main file alone may
  // not fire until a WAL checkpoint flushes data to the main DB.
  // The WAL file may not exist yet (fresh install, non-WAL mode) — the
  // try/catch gracefully skips it.
  const pathsToWatch = [CURSOR_STATE_DB_PATH, `${CURSOR_STATE_DB_PATH}-wal`];
  for (const p of pathsToWatch) {
    try {
      const w = fsSync.watch(p, () => {
        sessionWatcher.dirty = true;
      });
      sessionWatcher.watchers.push(w);
    } catch {
    }
  }

  sessionWatcher.reconciliationTimer = setInterval(() => {
    forceFullReconciliation = true;
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopSessionWatcher(): void {
  if (sessionWatcher.reconciliationTimer) {
    clearInterval(sessionWatcher.reconciliationTimer);
    sessionWatcher.reconciliationTimer = null;
  }

  for (const w of sessionWatcher.watchers) {
    w.close();
  }
  sessionWatcher.watchers = [];

  // Intentionally preserve dirty flag — it may have been set by
  // processDbChange and should persist until consumed by parseSessions.
  sessionWatcher.started = false;
}

export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  if (forceFullReconciliation) {
    forceFullReconciliation = false;
  }
  return value;
}

/** Debounce interval for fs.watch-triggered DB scans (ms). */
const ACTIVITY_DEBOUNCE_MS = 150;

/** Polling interval for activity detection fallback (ms). */
const ACTIVITY_POLL_MS = 1000;

/** Faster poll for pending bubbles awaiting content (during streaming). */
const PENDING_POLL_MS = 500;

function scheduleProcessDbChange(): void {
  // Debounce rapid fs.watch events into a single DB scan
  if (activityWatcher.debounceTimer) return;
  activityWatcher.debounceTimer = setTimeout(() => {
    activityWatcher.debounceTimer = null;
    processDbChange();
  }, ACTIVITY_DEBOUNCE_MS);
}

export function startActivityWatch(callback: ActivityCallback): void {
  // Always update the callback — the core may pass a new reference on
  // React re-renders (unstable useCallback identity). The callback must
  // always point to the latest handler.
  activityWatcher.callback = callback;

  // If watchers/polls are already running, nothing else to do.
  // The updated callback will be picked up by the next processDbChange.
  if (activityWatcher.started) return;
  activityWatcher.started = true;

  // Initialize the rowid cursor to the current max. Only bubbles inserted
  // AFTER this point will fire the callback. This replaces the old
  // primeKnownBubbles() full-scan approach.
  initializeRowIdCursor();

  // Watch both the main DB file and the WAL file for changes.
  // SQLite WAL mode writes to state.vscdb-wal; the main DB file is only
  // updated during checkpoints, so watching it alone misses real-time writes.
  const pathsToWatch = [CURSOR_STATE_DB_PATH, `${CURSOR_STATE_DB_PATH}-wal`];
  for (const p of pathsToWatch) {
    try {
      const w = fsSync.watch(p, () => {
        scheduleProcessDbChange();
      });
      activityWatcher.watchers.push(w);
    } catch {
    }
  }

  // Polling fallback: fs.watch isn't fully reliable for SQLite WAL writes
  // across all platforms. Poll at a low frequency as safety net.
  activityWatcher.pollTimer = setInterval(() => {
    processDbChange();
  }, ACTIVITY_POLL_MS);
}

export function stopActivityWatch(): void {
  // Only null the callback. Leave infrastructure (watchers, poll timer)
  // running. The core calls stop+start frequently due to React re-renders
  // (unstable useCallback identity in handleActivityUpdate). Tearing down
  // and recreating watchers/timers on each cycle is wasteful and risks
  // losing fs.watch events during the gap. processDbChange returns early
  // when callback is null, so the cost of idle polling is minimal.
  //
  // DO NOT set started = false — startActivityWatch checks this flag to
  // skip re-initialization when called again after a React re-render.
  //
  // DO NOT call stopSessionWatcher — the session watcher must remain
  // active to preserve its dirty flag and fs.watch handles. Previously,
  // stopSessionWatcher reset dirty = false, causing 30s+ detection delays
  // because the next parseSessions call saw isDirty = false and returned
  // stale cached data.
  //
  // DO NOT reset lastBubbleRowId — it must persist across stop/start cycles
  // to prevent re-firing callbacks for bubbles that were already processed.
  activityWatcher.callback = null;
}
