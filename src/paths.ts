import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const HOME = os.homedir();
const PLATFORM = os.platform();

export const CURSOR_HOME = path.join(HOME, '.cursor');

function getCursorUserDataPath(): string {
  switch (PLATFORM) {
    case 'darwin':
      return path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User');
    case 'win32':
      return path.join(process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User');
    default:
      return path.join(HOME, '.config', 'Cursor', 'User');
  }
}

const CURSOR_USER_DATA = getCursorUserDataPath();

export const CURSOR_GLOBAL_STORAGE_PATH = path.join(CURSOR_USER_DATA, 'globalStorage');
export const CURSOR_WORKSPACE_STORAGE_PATH = path.join(CURSOR_USER_DATA, 'workspaceStorage');
export const CURSOR_STATE_DB_PATH = path.join(CURSOR_GLOBAL_STORAGE_PATH, 'state.vscdb');

export async function getWorkspaceDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(CURSOR_WORKSPACE_STORAGE_PATH, { withFileTypes: true });
    const dirs: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(path.join(CURSOR_WORKSPACE_STORAGE_PATH, entry.name));
      }
    }

    return dirs;
  } catch {
    return [];
  }
}
