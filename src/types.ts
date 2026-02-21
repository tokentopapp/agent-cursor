import type { SessionUsageData } from '@tokentop/plugin-sdk';

/**
 * Cursor stores conversations as "composers" in its SQLite state database.
 * Each composer has metadata plus a list of bubble IDs that reference
 * individual messages stored separately in the same KV table.
 */

/** Bubble type: 1 = user message, 2 = assistant message. */
export type CursorBubbleType = 1 | 2;

/** Bubble header stored in composerData.fullConversationHeadersOnly. */
export interface CursorBubbleHeader {
  bubbleId: string;
  type: CursorBubbleType;
  serverBubbleId?: string;
}

/** Model config stored at the composer level (conversation default). */
export interface CursorModelConfig {
  modelName: string;
  maxMode?: boolean;
}

/** Token count stored per-bubble. */
export interface CursorTokenCount {
  inputTokens: number;
  outputTokens: number;
}

/** Model info stored per-bubble (may be null if not resolved). */
export interface CursorModelInfo {
  modelName: string;
}

/**
 * Composer data from cursorDiskKV `composerData:{composerId}`.
 * Only the fields we need for session parsing are typed here.
 */
export interface CursorComposerData {
  _v: number;
  composerId: string;
  name?: string;
  status: string;
  modelConfig: CursorModelConfig;
  usageData: Record<string, unknown>;
  fullConversationHeadersOnly: CursorBubbleHeader[];
  lastUpdatedAt: number;
  createdAt: number;
  isAgentic?: boolean;
  unifiedMode?: string;
  forceMode?: string;
}

/**
 * Individual bubble (message) from cursorDiskKV `bubbleId:{composerId}:{bubbleId}`.
 * Only the fields we need for token extraction are typed here.
 */
export interface CursorBubbleData {
  _v: number;
  type: CursorBubbleType;
  bubbleId: string;
  tokenCount: CursorTokenCount;
  modelInfo: CursorModelInfo | null;
  requestId: string;
  createdAt: string;
  isAgentic?: boolean;
}

/** Composer entry in the workspace-level `composer.composerData` list. */
export interface CursorWorkspaceComposerEntry {
  type: string;
  composerId: string;
  lastUpdatedAt?: number;
  createdAt: number;
  unifiedMode?: string;
  forceMode?: string;
  name?: string;
  subtitle?: string;
  isArchived?: boolean;
  isDraft?: boolean;
}

/** Workspace-level composer index from ItemTable `composer.composerData`. */
export interface CursorWorkspaceComposerIndex {
  allComposers: CursorWorkspaceComposerEntry[];
  selectedComposerIds: string[];
  lastFocusedComposerIds: string[];
  hasMigratedComposerData?: boolean;
  hasMigratedMultipleComposers?: boolean;
}

/** Workspace metadata from workspace.json. */
export interface CursorWorkspaceJson {
  folder: string;
}

/** Resolved workspace: project path + associated composer IDs. */
export interface CursorWorkspaceInfo {
  workspaceHash: string;
  projectPath: string;
  composerIds: string[];
}

/** Aggregate cache entry for parsed session data. */
export interface SessionAggregateCacheEntry {
  updatedAt: number;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
