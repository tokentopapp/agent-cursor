import * as fsSync from 'fs';
import type { ActivityCallback, ActivityUpdate } from '@tokentop/plugin-sdk';
import { CURSOR_STATE_DB_PATH } from './paths.ts';
import type { CursorBubbleData } from './types.ts';
import { openDatabase, readAllBubbleKeys, readAllComposerIds, readBubbleData } from './utils.ts';

export interface SessionWatcherState {
  watcher: fsSync.FSWatcher | null;
  dirty: boolean;
  reconciliationTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

interface ActivityWatcherState {
  watcher: fsSync.FSWatcher | null;
  callback: ActivityCallback | null;
  knownBubbleKeys: Set<string>;
  started: boolean;
}

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher: SessionWatcherState = {
  watcher: null,
  dirty: false,
  reconciliationTimer: null,
  started: false,
};

const activityWatcher: ActivityWatcherState = {
  watcher: null,
  callback: null,
  knownBubbleKeys: new Set(),
  started: false,
};

export let forceFullReconciliation = false;

const ASSISTANT_BUBBLE_TYPE = 2;

function isTokenBearingBubble(bubble: unknown): bubble is CursorBubbleData {
  if (!bubble || typeof bubble !== 'object') return false;

  const candidate = bubble as Partial<CursorBubbleData>;
  if (candidate.type !== ASSISTANT_BUBBLE_TYPE) return false;
  if (!candidate.tokenCount || typeof candidate.tokenCount !== 'object') return false;
  if (typeof candidate.tokenCount.inputTokens !== 'number' || candidate.tokenCount.inputTokens <= 0) return false;
  if (typeof candidate.tokenCount.outputTokens !== 'number') return false;
  if (typeof candidate.bubbleId !== 'string' || candidate.bubbleId.length === 0) return false;

  return true;
}

function toTimestamp(isoString: string | undefined): number {
  if (!isoString) return Date.now();
  const parsed = Date.parse(isoString);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function primeKnownBubbles(): void {
  const db = openDatabase(CURSOR_STATE_DB_PATH);
  if (!db) return;

  try {
    const composerIds = readAllComposerIds(db);

    for (const composerId of composerIds) {
      const bubbleIds = readAllBubbleKeys(db, composerId);
      for (const bubbleId of bubbleIds) {
        activityWatcher.knownBubbleKeys.add(`${composerId}:${bubbleId}`);
      }
    }
  } finally {
    db.close();
  }
}

function processDbChange(): void {
  const callback = activityWatcher.callback;
  if (!callback) return;

  const db = openDatabase(CURSOR_STATE_DB_PATH);
  if (!db) return;

  try {
    const composerIds = readAllComposerIds(db);

    for (const composerId of composerIds) {
      const bubbleIds = readAllBubbleKeys(db, composerId);

      for (const bubbleId of bubbleIds) {
        const compoundKey = `${composerId}:${bubbleId}`;
        if (activityWatcher.knownBubbleKeys.has(compoundKey)) continue;

        activityWatcher.knownBubbleKeys.add(compoundKey);

        const bubble = readBubbleData(db, composerId, bubbleId);
        if (!isTokenBearingBubble(bubble)) continue;

        const tokens: ActivityUpdate['tokens'] = {
          input: bubble.tokenCount.inputTokens,
          output: bubble.tokenCount.outputTokens,
        };

        callback({
          sessionId: composerId,
          messageId: bubble.bubbleId,
          tokens,
          timestamp: toTimestamp(bubble.createdAt),
        });
      }
    }
  } finally {
    db.close();
  }
}

export function startSessionWatcher(): void {
  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  try {
    sessionWatcher.watcher = fsSync.watch(CURSOR_STATE_DB_PATH, () => {
      sessionWatcher.dirty = true;
    });
  } catch {
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

  if (sessionWatcher.watcher) {
    sessionWatcher.watcher.close();
    sessionWatcher.watcher = null;
  }

  sessionWatcher.dirty = false;
  sessionWatcher.started = false;
}

export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  if (forceFullReconciliation) {
    forceFullReconciliation = false;
  }
  return value;
}

export function startActivityWatch(callback: ActivityCallback): void {
  activityWatcher.callback = callback;

  if (activityWatcher.started) return;
  activityWatcher.started = true;

  primeKnownBubbles();

  try {
    activityWatcher.watcher = fsSync.watch(CURSOR_STATE_DB_PATH, () => {
      processDbChange();
    });
  } catch {
  }
}

export function stopActivityWatch(): void {
  if (activityWatcher.watcher) {
    activityWatcher.watcher.close();
    activityWatcher.watcher = null;
  }

  activityWatcher.knownBubbleKeys.clear();
  activityWatcher.callback = null;
  activityWatcher.started = false;

  stopSessionWatcher();
}
