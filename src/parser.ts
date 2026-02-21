import type { Database } from 'bun:sqlite';
import * as fs from 'fs/promises';
import type { AgentFetchContext, SessionParseOptions, SessionUsageData } from '@tokentop/plugin-sdk';
import {
  CACHE_TTL_MS,
  composerMetadataIndex,
  evictSessionAggregateCache,
  sessionAggregateCache,
  sessionCache,
} from './cache.ts';
import { CURSOR_STATE_DB_PATH, getWorkspaceDirs } from './paths.ts';
import type { CursorBubbleData, CursorComposerData, CursorWorkspaceInfo } from './types.ts';
import {
  openDatabase,
  parseWorkspaceFolderUri,
  readAllBubbleKeys,
  readAllComposerIds,
  readBubbleData,
  readComposerData,
  readWorkspaceComposerIndex,
  readWorkspaceJson,
  resolveProviderId,
} from './utils.ts';
import { consumeForceFullReconciliation, sessionWatcher, startSessionWatcher } from './watcher.ts';

const ASSISTANT_BUBBLE_TYPE = 2;

interface ComposerWithMeta {
  composerId: string;
  lastUpdatedAt: number;
  projectPath: string | undefined;
  sessionName: string | undefined;
}

export function toTimestamp(isoString: string | undefined, fallback: number): number {
  if (!isoString) return fallback;
  const parsed = Date.parse(isoString);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isTokenBearingBubble(bubble: unknown): bubble is CursorBubbleData {
  if (!bubble || typeof bubble !== 'object') return false;

  const candidate = bubble as Partial<CursorBubbleData>;
  if (candidate.type !== ASSISTANT_BUBBLE_TYPE) return false;
  if (!candidate.tokenCount || typeof candidate.tokenCount !== 'object') return false;
  if (typeof candidate.tokenCount.inputTokens !== 'number' || candidate.tokenCount.inputTokens <= 0) return false;
  if (typeof candidate.tokenCount.outputTokens !== 'number') return false;
  if (typeof candidate.bubbleId !== 'string' || candidate.bubbleId.length === 0) return false;

  return true;
}

function resolveModelName(bubble: CursorBubbleData, composer: CursorComposerData): string {
  const bubbleModel = bubble.modelInfo?.modelName;
  if (bubbleModel && bubbleModel !== 'default' && bubbleModel !== '?') {
    return bubbleModel;
  }

  const composerModel = composer.modelConfig?.modelName;
  if (composerModel && composerModel !== 'default') {
    return composerModel;
  }

  return 'cursor-default';
}

export function parseComposerBubbles(
  db: Database,
  meta: ComposerWithMeta,
  composer: CursorComposerData,
): SessionUsageData[] {
  const deduped = new Map<string, SessionUsageData>();
  const bubbleIds = readAllBubbleKeys(db, meta.composerId);

  for (const bubbleId of bubbleIds) {
    const bubble = readBubbleData(db, meta.composerId, bubbleId);
    if (!isTokenBearingBubble(bubble)) continue;

    const modelId = resolveModelName(bubble, composer);
    const providerId = resolveProviderId(modelId);
    const timestamp = toTimestamp(bubble.createdAt, meta.lastUpdatedAt);

    const usage: SessionUsageData = {
      sessionId: meta.composerId,
      providerId,
      modelId,
      tokens: {
        input: bubble.tokenCount.inputTokens,
        output: bubble.tokenCount.outputTokens,
      },
      timestamp,
      sessionUpdatedAt: meta.lastUpdatedAt,
    };

    if (meta.sessionName) {
      usage.sessionName = meta.sessionName;
    }
    if (meta.projectPath) {
      usage.projectPath = meta.projectPath;
    }

    deduped.set(bubble.bubbleId, usage);
  }

  return Array.from(deduped.values());
}

async function buildWorkspaceMap(): Promise<Map<string, CursorWorkspaceInfo>> {
  const workspaceDirs = await getWorkspaceDirs();
  const composerToWorkspace = new Map<string, CursorWorkspaceInfo>();

  for (const wsDir of workspaceDirs) {
    const workspaceJson = await readWorkspaceJson(wsDir);
    if (!workspaceJson?.folder) continue;

    const projectPath = parseWorkspaceFolderUri(workspaceJson.folder);
    const workspaceHash = wsDir.split('/').pop() ?? wsDir.split('\\').pop() ?? '';

    const index = readWorkspaceComposerIndex(wsDir);
    if (!index?.allComposers) continue;

    const composerIds = index.allComposers.map((c) => c.composerId);

    const info: CursorWorkspaceInfo = {
      workspaceHash,
      projectPath,
      composerIds,
    };

    for (const cid of composerIds) {
      composerToWorkspace.set(cid, info);
    }
  }

  return composerToWorkspace;
}

export async function parseSessionsFromWorkspaces(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
): Promise<SessionUsageData[]> {
  const limit = options.limit ?? 100;
  const since = options.since;

  try {
    await fs.access(CURSOR_STATE_DB_PATH);
  } catch {
    ctx.logger.debug('No Cursor state database found');
    return [];
  }

  startSessionWatcher();

  const now = Date.now();
  if (
    !options.sessionId &&
    limit === sessionCache.lastLimit &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('Cursor: using cached sessions (within TTL)', { count: sessionCache.lastResult.length });
    return sessionCache.lastResult;
  }

  const isDirty = sessionWatcher.dirty;
  sessionWatcher.dirty = false;

  const needsFullStat = consumeForceFullReconciliation();
  if (needsFullStat) {
    ctx.logger.debug('Cursor: full reconciliation sweep triggered');
  }

  const db = openDatabase(CURSOR_STATE_DB_PATH);
  if (!db) {
    ctx.logger.debug('Cursor: failed to open state database');
    return [];
  }

  try {
    const composerToWorkspace = await buildWorkspaceMap();
    const composerIds = options.sessionId ? [options.sessionId] : readAllComposerIds(db);

    const composers: ComposerWithMeta[] = [];
    const seenComposerIds = new Set<string>();

    let statCount = 0;
    let statSkipCount = 0;

    for (const composerId of composerIds) {
      seenComposerIds.add(composerId);

      const composerData = readComposerData(db, composerId);
      if (!composerData) continue;

      const lastUpdatedAt = composerData.lastUpdatedAt || composerData.createdAt || 0;

      const metadata = composerMetadataIndex.get(composerId);
      if (!isDirty && !needsFullStat && metadata && metadata.lastUpdatedAt === lastUpdatedAt) {
        statSkipCount++;

        if (!since || lastUpdatedAt >= since) {
          const wsInfo = composerToWorkspace.get(composerId);
          composers.push({
            composerId,
            lastUpdatedAt,
            projectPath: wsInfo?.projectPath,
            sessionName: composerData.name,
          });
        }
        continue;
      }

      statCount++;
      composerMetadataIndex.set(composerId, { lastUpdatedAt, composerId });

      if (since && lastUpdatedAt < since) continue;

      const wsInfo = composerToWorkspace.get(composerId);
      composers.push({
        composerId,
        lastUpdatedAt,
        projectPath: wsInfo?.projectPath,
        sessionName: composerData.name,
      });
    }

    for (const cachedId of composerMetadataIndex.keys()) {
      if (!seenComposerIds.has(cachedId)) {
        composerMetadataIndex.delete(cachedId);
      }
    }

    composers.sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);

    const sessions: SessionUsageData[] = [];
    let aggregateCacheHits = 0;
    let aggregateCacheMisses = 0;

    for (const meta of composers) {
      const cached = sessionAggregateCache.get(meta.composerId);
      if (cached && cached.updatedAt === meta.lastUpdatedAt) {
        cached.lastAccessed = now;
        aggregateCacheHits++;
        sessions.push(...cached.usageRows);
        continue;
      }

      aggregateCacheMisses++;

      const composerData = readComposerData(db, meta.composerId);
      if (!composerData) continue;

      const usageRows = parseComposerBubbles(db, meta, composerData);

      sessionAggregateCache.set(meta.composerId, {
        updatedAt: meta.lastUpdatedAt,
        usageRows,
        lastAccessed: now,
      });

      sessions.push(...usageRows);
    }

    evictSessionAggregateCache();

    if (!options.sessionId) {
      sessionCache.lastCheck = Date.now();
      sessionCache.lastResult = sessions;
      sessionCache.lastLimit = limit;
      sessionCache.lastSince = since;
    }

    ctx.logger.debug('Cursor: parsed sessions', {
      count: sessions.length,
      composers: composers.length,
      statChecks: statCount,
      statSkips: statSkipCount,
      aggregateCacheHits,
      aggregateCacheMisses,
      metadataIndexSize: composerMetadataIndex.size,
      aggregateCacheSize: sessionAggregateCache.size,
    });

    return sessions;
  } finally {
    db.close();
  }
}
