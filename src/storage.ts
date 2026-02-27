import type { PluginStorage } from '@tokentop/plugin-sdk';
import type { SessionUsageData } from '@tokentop/plugin-sdk';

/**
 * Module-level reference to the plugin's persistent KV storage.
 *
 * Captured from `PluginContext` during the first lifecycle call
 * (`isInstalled` or `startActivityWatch`) and used by csv.ts to
 * persist/load the per-session enrichment cache across restarts.
 */
let pluginStorage: PluginStorage | null = null;

const ENRICHMENT_CACHE_KEY = 'enrichment-cache';

/** Capture the storage reference from a PluginContext. Safe to call multiple times. */
export function setPluginStorage(storage: PluginStorage): void {
  pluginStorage = storage;
}

/** Serializable shape for persisted enrichment data. */
interface PersistedEnrichmentCache {
  /** ISO timestamp of when this cache was last saved. */
  savedAt: string;
  /** Map of sessionId → enriched usage rows. */
  sessions: Record<string, SessionUsageData[]>;
}

/**
 * Load the enrichment cache from persistent storage.
 * Returns a Map of sessionId → enriched rows, or null if nothing is stored.
 */
export async function loadEnrichmentCache(): Promise<Map<string, SessionUsageData[]> | null> {
  if (!pluginStorage) return null;

  try {
    const raw = await pluginStorage.get(ENRICHMENT_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as PersistedEnrichmentCache;
    if (!parsed.sessions || typeof parsed.sessions !== 'object') return null;

    const map = new Map<string, SessionUsageData[]>();
    for (const [sessionId, rows] of Object.entries(parsed.sessions)) {
      if (Array.isArray(rows) && rows.length > 0) {
        map.set(sessionId, rows);
      }
    }

    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
}

/**
 * Save the enrichment cache to persistent storage.
 * Fire-and-forget — errors are silently ignored.
 */
export function saveEnrichmentCache(cache: Map<string, SessionUsageData[]>): void {
  if (!pluginStorage || cache.size === 0) return;

  const payload: PersistedEnrichmentCache = {
    savedAt: new Date().toISOString(),
    sessions: Object.fromEntries(cache),
  };

  pluginStorage.set(ENRICHMENT_CACHE_KEY, JSON.stringify(payload)).catch(() => {});
}
