import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAgentPlugin,
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';

// TODO: Implement session parsing for Cursor
// See @tokentop/agent-opencode for a complete reference implementation.

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
      paths: ['~/.cursor'],
    },
  },

  agent: {
    name: 'Cursor',
    command: 'cursor',
    configPath: path.join(os.homedir(), '.cursor'),
    sessionPath: path.join(os.homedir(), '.cursor'),
  },

  capabilities: {
    sessionParsing: false,
    authReading: false,
    realTimeTracking: false,
    multiProvider: false,
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    return fs.existsSync(path.join(os.homedir(), '.cursor'));
  },

  async parseSessions(_options: SessionParseOptions, _ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return [];
  },
});

export default cursorAgentPlugin;
