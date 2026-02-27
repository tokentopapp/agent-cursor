import type { AgentFetchContext, SessionUsageData } from '@tokentop/plugin-sdk';
import { buildSessionCookie } from './auth.ts';
import { loadEnrichmentCache, saveEnrichmentCache } from './storage.ts';
import type { CursorCsvUsageRow } from './types.ts';

const USAGE_CSV_URL = 'https://cursor.com/api/dashboard/export-usage-events-csv?strategy=tokens';

/** Default TTL for cached CSV data. Overridden by `csvRefreshMinutes` config. */
export const CSV_CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum timestamp gap (ms) between a session and a CSV row to consider them a match. */
const MATCH_WINDOW_MS = 60_000;

interface CsvCacheState {
  rows: CursorCsvUsageRow[];
  fetchedAt: number;
}

let csvCache: CsvCacheState | null = null;
let csvFetchInFlight: Promise<void> | null = null;

/**
 * Per-session cache of enriched usage rows. Survives CSV cache invalidation
 * and TTL expiry so that previously-enriched sessions retain their accurate
 * token data even when new activity triggers a CSV re-fetch.
 *
 * On first access, hydrated from persistent PluginStorage (if available)
 * so enriched data also survives app restarts.
 */
const sessionEnrichmentCache = new Map<string, SessionUsageData[]>();
let enrichmentCacheHydrated = false;

/**
 * Parse Cursor's CSV usage export into structured rows.
 *
 * CSV columns (in order):
 *   Date, Kind, Model, Max Mode, Input (w/ Cache Write),
 *   Input (w/o Cache Write), Cache Read, Output Tokens, Total Tokens, Cost
 */
export function parseUsageCsv(csvText: string): CursorCsvUsageRow[] {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const rows: CursorCsvUsageRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    // Strip surrounding quotes from each field (Cursor's CSV quotes all values)
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, ''));
    if (cols.length < 10) continue;

    const timestamp = Date.parse(cols[0]!);
    if (!Number.isFinite(timestamp)) continue;

    const outputTokens = parseInt(cols[7]!, 10);
    if (!Number.isFinite(outputTokens) || outputTokens <= 0) continue;

    rows.push({
      timestamp,
      kind: cols[1]!.trim(),
      model: cols[2]!.trim(),
      maxMode: cols[3]!.trim().toLowerCase() === 'true',
      inputTokensWithCacheWrite: parseInt(cols[4]!, 10) || 0,
      inputTokensWithoutCacheWrite: parseInt(cols[5]!, 10) || 0,
      cacheReadTokens: parseInt(cols[6]!, 10) || 0,
      outputTokens,
      totalTokens: parseInt(cols[8]!, 10) || 0,
      cost: parseFloat(cols[9]!) || 0,
    });
  }

  return rows;
}

/**
 * Fetch the CSV usage export from Cursor's dashboard API.
 * Auth is built from locally-stored credentials (no manual token entry).
 */
async function fetchCsvFromServer(
  ctx: AgentFetchContext,
): Promise<CursorCsvUsageRow[]> {
  const cookie = buildSessionCookie();
  if (!cookie) {
    ctx.logger.debug('Cursor CSV: no auth token available');
    return [];
  }

  const response = await ctx.http.fetch(USAGE_CSV_URL, {
    headers: { Cookie: cookie },
    signal: ctx.signal,
  });

  if (!response.ok) {
    ctx.logger.debug('Cursor CSV: fetch failed', { status: response.status });
    return [];
  }

  const csvText = await response.text();
  return parseUsageCsv(csvText);
}

/**
 * Get cached CSV data, awaiting the fetch when the cache is stale or empty.
 *
 * Reads `csvEnrichment` and `csvRefreshMinutes` from `ctx.config`.
 * When the cache is missing or expired, awaits the server fetch (~1-3s)
 * so enriched data lands on the same parseSessions cycle. Fresh cache
 * returns immediately with no network call.
 */
export async function getCsvRows(ctx: AgentFetchContext): Promise<CursorCsvUsageRow[]> {
  // Respect the csvEnrichment toggle
  if (ctx.config.csvEnrichment === false) return [];

  const refreshMinutes = typeof ctx.config.csvRefreshMinutes === 'number'
    ? ctx.config.csvRefreshMinutes
    : 5;
  const ttlMs = refreshMinutes * 60 * 1000;
  const now = Date.now();

  // Fresh cache — return immediately
  if (csvCache && now - csvCache.fetchedAt < ttlMs) {
    return csvCache.rows;
  }

  // Kick off fetch if none in flight
  if (!csvFetchInFlight) {
    csvFetchInFlight = fetchCsvFromServer(ctx)
      .then((rows) => {
        csvCache = { rows, fetchedAt: Date.now() };
        ctx.logger.debug('Cursor CSV: cached', { rowCount: rows.length });
      })
      .catch((err) => {
        ctx.logger.debug('Cursor CSV: fetch error', { error: String(err) });
      })
      .finally(() => {
        csvFetchInFlight = null;
      });
  }

  // Await the fetch so enrichment lands on this parseSessions cycle.
  if (csvFetchInFlight) {
    await csvFetchInFlight;
  }

  return csvCache?.rows ?? [];
}

/**
 * Invalidate the CSV cache so the next `getCsvRows` call triggers a
 * fresh background fetch. Does NOT clear the per-session enrichment
 * cache — previously-enriched sessions keep their accurate data.
 */
export function invalidateCsvCache(): void {
  csvCache = null;
}

/**
 * Hydrate the in-memory enrichment cache from persistent storage on first access.
 * Runs once — subsequent calls are no-ops.
 */
async function hydrateEnrichmentCache(): Promise<void> {
  if (enrichmentCacheHydrated) return;
  enrichmentCacheHydrated = true;

  const persisted = await loadEnrichmentCache();
  if (!persisted) return;

  for (const [sessionId, rows] of persisted) {
    // Don't overwrite entries that were populated during this run
    if (!sessionEnrichmentCache.has(sessionId)) {
      sessionEnrichmentCache.set(sessionId, rows);
    }
  }
}

/**
 * Enrich locally-parsed session rows with actual token data from the CSV export.
 *
 * The CSV contains per-session aggregates, not per-bubble data. This function:
 * 1. Groups local rows by sessionId
 * 2. Matches each session to a CSV row by timestamp proximity (±60s)
 *    using sessionUpdatedAt — model matching is skipped because Cursor
 *    reports "auto" in the CSV rather than the resolved model name
 * 3. Distributes the CSV totals across the session's bubbles
 *    proportionally based on each bubble's estimated output tokens
 * 4. Caches enriched results per-session so they survive CSV cache
 *    expiry and DB activity without regressing to estimates
 * 5. Persists the enrichment cache to PluginStorage so data survives restarts
 *
 * When called with no CSV rows (cache miss / TTL expired / first call),
 * returns previously-enriched data from the per-session cache for known
 * sessions. New/unenriched sessions keep their local estimates.
 */
export async function enrichWithCsvData(
  localRows: SessionUsageData[],
  csvRows: CursorCsvUsageRow[],
): Promise<SessionUsageData[]> {
  // Hydrate from persistent storage on first call
  await hydrateEnrichmentCache();
  // No CSV data available — use per-session enrichment cache as fallback
  if (csvRows.length === 0) {
    if (sessionEnrichmentCache.size === 0) return localRows;
    return applyEnrichmentCache(localRows);
  }

  // Group local rows by sessionId
  const sessionGroups = new Map<string, { rows: SessionUsageData[] }>();
  for (const row of localRows) {
    const existing = sessionGroups.get(row.sessionId);
    if (existing) {
      existing.rows.push(row);
    } else {
      sessionGroups.set(row.sessionId, { rows: [row] });
    }
  }

  // Match sessions to CSV rows by timestamp proximity
  const sortedCsv = [...csvRows].sort((a, b) => a.timestamp - b.timestamp);
  const usedCsvIndices = new Set<number>();
  const sessionCsvMap = new Map<string, CursorCsvUsageRow>();

  for (const [sessionId, group] of sessionGroups) {
    // Use the latest row's sessionUpdatedAt for matching
    const updatedAt = group.rows.reduce((max, r) => {
      const ts = r.sessionUpdatedAt ?? r.timestamp;
      return ts > max ? ts : max;
    }, 0);

    let bestIdx = -1;
    let bestDelta = Infinity;

    for (let i = 0; i < sortedCsv.length; i++) {
      if (usedCsvIndices.has(i)) continue;
      const delta = Math.abs(sortedCsv[i]!.timestamp - updatedAt);
      if (delta > MATCH_WINDOW_MS) continue;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }

    if (bestIdx !== -1) {
      usedCsvIndices.add(bestIdx);
      sessionCsvMap.set(sessionId, sortedCsv[bestIdx]!);
    }
  }

  // Distribute CSV totals across each session's bubbles proportionally
  const enrichedRows = localRows.map((row) => {
    const csv = sessionCsvMap.get(row.sessionId);
    if (!csv) return row;

    const group = sessionGroups.get(row.sessionId)!;
    const totalEstOutput = group.rows.reduce((sum, r) => sum + r.tokens.output, 0);
    const weight = totalEstOutput > 0
      ? row.tokens.output / totalEstOutput
      : 1 / group.rows.length;

    const cacheWrite = csv.inputTokensWithCacheWrite - csv.inputTokensWithoutCacheWrite;

    return {
      ...row,
      tokens: {
        input: Math.round(csv.inputTokensWithoutCacheWrite * weight),
        output: Math.round(csv.outputTokens * weight),
        ...(csv.cacheReadTokens > 0 ? { cacheRead: Math.round(csv.cacheReadTokens * weight) } : {}),
        ...(cacheWrite > 0 ? { cacheWrite: Math.round(cacheWrite * weight) } : {}),
      },
      ...(csv.cost > 0 ? { cost: Number((csv.cost * weight).toFixed(6)) } : {}),
      metadata: { isEstimated: false },
    };
  });

  // Cache enriched rows per-session for fallback when CSV is unavailable.
  // Also persist to PluginStorage so enriched data survives app restarts.
  let cacheUpdated = false;
  for (const [sessionId] of sessionCsvMap) {
    const sessionRows = enrichedRows.filter(r => r.sessionId === sessionId);
    if (sessionRows.length > 0) {
      sessionEnrichmentCache.set(sessionId, sessionRows);
      cacheUpdated = true;
    }
  }

  if (cacheUpdated) {
    saveEnrichmentCache(sessionEnrichmentCache);
  }

  // For sessions that weren't matched to CSV, try the enrichment cache
  if (sessionCsvMap.size < sessionGroups.size && sessionEnrichmentCache.size > 0) {
    return enrichedRows.map((row) => {
      if (sessionCsvMap.has(row.sessionId)) return row;
      return applyCachedEnrichmentToRow(row) ?? row;
    });
  }

  return enrichedRows;
}

/**
 * Apply cached enrichment data to all rows, using cached enriched rows
 * for known sessions and passing through unenriched rows as-is.
 */
function applyEnrichmentCache(localRows: SessionUsageData[]): SessionUsageData[] {
  return localRows.map((row) => applyCachedEnrichmentToRow(row) ?? row);
}

/**
 * Look up a single row's enrichment from the per-session cache.
 * Matches by sessionId + timestamp to find the corresponding cached row.
 * Returns null if no cached enrichment is available.
 */
function applyCachedEnrichmentToRow(row: SessionUsageData): SessionUsageData | null {
  const cachedRows = sessionEnrichmentCache.get(row.sessionId);
  if (!cachedRows) return null;

  // Find matching cached row by timestamp (each bubble has a unique timestamp)
  const match = cachedRows.find(c => c.timestamp === row.timestamp);
  if (!match) return null;

  return {
    ...row,
    tokens: match.tokens,
    ...(match.cost !== undefined ? { cost: match.cost } : {}),
    metadata: { isEstimated: false },
  };
}

/** Reset CSV cache and enrichment cache — for testing. */
export function resetCsvCache(): void {
  csvCache = null;
  csvFetchInFlight = null;
  sessionEnrichmentCache.clear();
}
