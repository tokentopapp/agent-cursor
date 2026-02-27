import * as fs from 'fs';
import {
  createAgentPlugin,
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, SESSION_AGGREGATE_CACHE_MAX, composerMetadataIndex, sessionAggregateCache, sessionCache } from './cache.ts';
import { parseSessionsFromWorkspaces } from './parser.ts';
import { CURSOR_GLOBAL_STORAGE_PATH, CURSOR_HOME, CURSOR_STATE_DB_PATH, CURSOR_WORKSPACE_STORAGE_PATH } from './paths.ts';
import { RECONCILIATION_INTERVAL_MS, startActivityWatch, stopActivityWatch } from './watcher.ts';
import { CSV_CACHE_TTL_MS, resetCsvCache } from './csv.ts';
import { setPluginStorage } from './storage.ts';

const cursorAgentPlugin = createAgentPlugin({
  id: 'cursor',
  type: 'agent',
  name: 'Cursor',
  version: '0.1.0',

  meta: {
    description: 'Cursor AI editor session tracking',
    homepage: 'https://cursor.com',
  },

  permissions: {
    filesystem: {
      read: true,
      paths: ['~/.cursor', '~/Library/Application Support/Cursor', '~/.config/Cursor'],
    },
    network: {
      enabled: true,
      allowedDomains: ['cursor.com'],
    },
  },

  agent: {
    name: 'Cursor',
    command: 'cursor',
    configPath: CURSOR_HOME,
    sessionPath: CURSOR_GLOBAL_STORAGE_PATH,
  },

  capabilities: {
    sessionParsing: true,
    authReading: false,
    realTimeTracking: true,
    multiProvider: false,
  },

  configSchema: {
    csvEnrichment: {
      type: 'boolean',
      label: 'Server enrichment',
      description: 'Fetch accurate token counts and costs from Cursor\'s server. When enabled, local estimates are replaced with exact data on subsequent refreshes.',
      default: true,
    },
    csvRefreshMinutes: {
      type: 'number',
      label: 'Server refresh interval',
      description: 'How often to fetch updated token data from the server (minutes).',
      default: 5,
      min: 1,
      max: 60,
    },
    estimateTokens: {
      type: 'boolean',
      label: 'Estimate tokens',
      description: 'Estimate output tokens from response text when exact server counts are unavailable. Provides immediate visibility while server data loads.',
      default: true,
    },
  },

  defaultConfig: {
    csvEnrichment: true,
    csvRefreshMinutes: 5,
    estimateTokens: true,
  },

  startActivityWatch(ctx: PluginContext, callback): void {
    setPluginStorage(ctx.storage);
    startActivityWatch(callback);
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatch();
  },

  async isInstalled(ctx: PluginContext): Promise<boolean> {
    setPluginStorage(ctx.storage);
    return fs.existsSync(CURSOR_STATE_DB_PATH) || fs.existsSync(CURSOR_HOME);
  },

  async parseSessions(options: SessionParseOptions, ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return parseSessionsFromWorkspaces(options, ctx);
  },
});

export {
  CACHE_TTL_MS,
  CSV_CACHE_TTL_MS,
  CURSOR_GLOBAL_STORAGE_PATH,
  CURSOR_HOME,
  CURSOR_STATE_DB_PATH,
  CURSOR_WORKSPACE_STORAGE_PATH,
  RECONCILIATION_INTERVAL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  composerMetadataIndex,
  resetCsvCache,
  sessionAggregateCache,
  sessionCache,
};

export default cursorAgentPlugin;
