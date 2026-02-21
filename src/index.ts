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

  startActivityWatch(_ctx: PluginContext, callback): void {
    startActivityWatch(callback);
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatch();
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    return fs.existsSync(CURSOR_STATE_DB_PATH) || fs.existsSync(CURSOR_HOME);
  },

  async parseSessions(options: SessionParseOptions, ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return parseSessionsFromWorkspaces(options, ctx);
  },
});

export {
  CACHE_TTL_MS,
  CURSOR_GLOBAL_STORAGE_PATH,
  CURSOR_HOME,
  CURSOR_STATE_DB_PATH,
  CURSOR_WORKSPACE_STORAGE_PATH,
  RECONCILIATION_INTERVAL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  composerMetadataIndex,
  sessionAggregateCache,
  sessionCache,
};

export default cursorAgentPlugin;
