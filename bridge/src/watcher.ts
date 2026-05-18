import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { relToCwd } from './files.ts';

export type FileChange = { op: 'add' | 'change' | 'unlink'; path: string; rel: string };

interface WatcherEvents {
  change: (info: FileChange) => void;
}

const IGNORE = /(^|[\\/])(node_modules|\.git|\.next|dist|build|\.turbo|\.cache|\.vercel|target|coverage|\.expo|ios\/build|android\/build|Pods|DerivedData|out|\.parcel-cache|\.svelte-kit|\.idea|\.vscode|__pycache__|\.venv|venv|env|\.pytest_cache|.mypy_cache)([\\/]|$)/;

const WATCH_DEPTH = Number(process.env.WATCHER_DEPTH ?? 4);
const USE_POLLING = process.env.WATCHER_POLLING === '1';

/**
 * File watcher per session-cwd. We share watchers across sessions that point at
 * the same cwd so we don't double-fire events for shared monorepos. Depth is
 * capped tight to avoid blowing past macOS's FD limit on big projects.
 */
class WatcherRegistry extends EventEmitter {
  private watchers = new Map<string, { watcher: FSWatcher; refCount: number; emitter: EventEmitter }>();

  acquire(cwd: string): EventEmitter {
    let entry = this.watchers.get(cwd);
    if (!entry) {
      const emitter = new EventEmitter();
      const watcher = chokidar.watch(cwd, {
        ignored: (p) => IGNORE.test(p),
        ignoreInitial: true,
        persistent: true,
        depth: WATCH_DEPTH,
        usePolling: USE_POLLING,
        interval: 1000,
        binaryInterval: 2000,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      watcher.on('add', (path) => emitter.emit('change', { op: 'add', path, rel: relToCwd(cwd, path) } satisfies FileChange));
      watcher.on('change', (path) => emitter.emit('change', { op: 'change', path, rel: relToCwd(cwd, path) } satisfies FileChange));
      watcher.on('unlink', (path) => emitter.emit('change', { op: 'unlink', path, rel: relToCwd(cwd, path) } satisfies FileChange));
      watcher.on('error', (err) => console.error(`[watcher ${cwd}]`, err));
      entry = { watcher, refCount: 0, emitter };
      this.watchers.set(cwd, entry);
    }
    entry.refCount += 1;
    return entry.emitter;
  }

  release(cwd: string): void {
    const entry = this.watchers.get(cwd);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
      entry.watcher.close().catch(() => undefined);
      entry.emitter.removeAllListeners();
      this.watchers.delete(cwd);
    }
  }

  shutdown(): void {
    for (const entry of this.watchers.values()) {
      entry.watcher.close().catch(() => undefined);
      entry.emitter.removeAllListeners();
    }
    this.watchers.clear();
  }
}

export const watchers = new WatcherRegistry();

export type { WatcherEvents };
