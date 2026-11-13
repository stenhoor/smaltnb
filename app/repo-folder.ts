// A local repository folder (ADR 0032, stenhoor/smalt-brand docs/adr): the page opens notebooks from a folder on the
// user's disk and saves them back as plain files, through the File System Access API (Chrome and Edge). When the folder
// is a git repository, `.git` is read, never written, with smaltkit/git: the branch, and each notebook as it was at
// HEAD, to show what changed. Commits and syncing are the user's, in their own tools; nothing here holds a credential.

import { blobId, gitDirFromHandle, openRepository, type Repository } from 'smaltkit/git';

/** Whether this browser can open a folder (Firefox and Safari can't: they open and download files). */
export const canOpenFolders = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(o: { mode: 'readwrite' }): Promise<PermissionState>;
};

const SKIP = new Set(['node_modules', 'dist', 'dist-app']);

export class RepoFolder {
  readonly root: FileSystemDirectoryHandle;
  readonly repo: Repository | null;
  readonly notebooks: string[];

  private constructor(root: FileSystemDirectoryHandle, repo: Repository | null, notebooks: string[]) {
    this.root = root;
    this.repo = repo;
    this.notebooks = notebooks;
  }

  get name(): string {
    return this.root.name;
  }

  /** Reads a folder: its notebooks (`*.nb.ts`, outside hidden folders and node_modules), and its git repository, if any. */
  static async open(root: FileSystemDirectoryHandle): Promise<RepoFolder> {
    let repo: Repository | null = null;
    try {
      repo = await openRepository(gitDirFromHandle(await root.getDirectoryHandle('.git')));
    } catch {
      // Not a repository (or a worktree, whose .git is a file): the folder still works, without changes.
    }
    const notebooks: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      if (depth > 6) return;
      for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (name.startsWith('.') || SKIP.has(name)) continue;
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1);
        else if (name.endsWith('.nb.ts')) notebooks.push(prefix + name);
      }
    };
    await walk(root, '', 0);
    return new RepoFolder(root, repo, notebooks.sort());
  }

  async #file(path: string, create = false): Promise<FileSystemFileHandle> {
    const parts = path.split('/');
    let dir = this.root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
    return dir.getFileHandle(parts.at(-1)!, { create });
  }

  async read(path: string): Promise<string> {
    return (await (await this.#file(path)).getFile()).text();
  }

  /** Writes the file whole, as an editor saves. */
  async write(path: string, text: string): Promise<void> {
    const w = await (await this.#file(path, true)).createWritable();
    await w.write(text);
    await w.close();
  }

  /** The branch HEAD is on, `detached at abc1234`, or null outside a repository. */
  async branch(): Promise<string | null> {
    if (!this.repo) return null;
    return (await this.repo.currentBranch()) ?? `detached at ${(await this.repo.resolve('HEAD')).slice(0, 7)}`;
  }

  /** The notebook as it is at HEAD, or null (outside a repository, before the first commit, or a new file). */
  async atHead(path: string): Promise<string | null> {
    if (!this.repo) return null;
    try {
      return await this.repo.readText('HEAD', path);
    } catch {
      return null;
    }
  }

  /** Whether the text differs from HEAD's version: git's own comparison, by blob id. Null outside a repository. */
  async changedSinceHead(path: string, text: string): Promise<boolean | null> {
    if (!this.repo) return null;
    let entry;
    try {
      entry = await this.repo.entryAt('HEAD', path);
    } catch {
      return true; // no commits yet
    }
    return !entry || entry.id !== (await blobId(new TextEncoder().encode(text)));
  }
}

// The folder is remembered (IndexedDB keeps the handle) so a reload reopens it. The browser may ask again for access.
const DB = 'smaltnb-folder';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction('handles', mode).objectStore('handles'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Remembers the folder and the notebook open in it. */
export async function rememberFolder(root: FileSystemDirectoryHandle | null, path: string | null): Promise<void> {
  try {
    await idb<unknown>('readwrite', (s) => (root ? s.put({ root, path }, 'last') : s.delete('last')) as IDBRequest<unknown>);
  } catch {
    // Storage blocked: the folder isn't remembered.
  }
}

/** The remembered folder and notebook, and whether access is still granted (else it needs a click to ask). */
export async function rememberedFolder(): Promise<{ root: FileSystemDirectoryHandle; path: string | null; granted: boolean } | null> {
  try {
    const last = await idb<{ root: Permissioned; path: string | null } | undefined>('readonly', (s) => s.get('last'));
    if (!last) return null;
    return { root: last.root, path: last.path, granted: (await last.root.queryPermission({ mode: 'readwrite' })) === 'granted' };
  } catch {
    return null;
  }
}

/** Asks for access to a remembered folder again (needs a click). */
export async function requestAccess(root: FileSystemDirectoryHandle): Promise<boolean> {
  return (await (root as Permissioned).requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** Asks the user to pick a folder (needs a click). Null when they cancel. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (globalThis as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'smaltnb', mode: 'readwrite' });
  } catch {
    return null; // cancelled
  }
}
