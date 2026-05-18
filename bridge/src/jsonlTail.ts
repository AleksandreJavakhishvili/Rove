import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export interface JsonlTailOptions {
  path: string;
  /** Called with each new complete line of JSON appended to the file. */
  onLine: (line: string) => void | Promise<void>;
  /** Optional error sink. Failures don't stop the watcher. */
  onError?: (err: Error) => void;
}

/**
 * Tails a JSONL file. On start, seeks to the current end-of-file so previously
 * written lines are NOT replayed (assumes the caller already loaded history via
 * another path). On file changes, reads only the bytes that were appended
 * since the last read.
 *
 * Single-file `fs.watch` is cheaper than `chokidar` for this purpose — chokidar
 * is built for tree-watching and adds unnecessary overhead per file.
 */
export class JsonlTail {
  private offset = 0;
  private watcher: FSWatcher | null = null;
  private buffer = '';
  private reading = false;
  private pending = false;
  private stopped = false;

  constructor(private opts: JsonlTailOptions) {}

  async start(): Promise<void> {
    try {
      const s = await stat(this.opts.path);
      this.offset = s.size;
    } catch {
      // File doesn't exist yet — that's fine, fs.watch handles the create.
      this.offset = 0;
    }
    if (this.stopped) return;
    try {
      this.watcher = watch(this.opts.path, () => this.scheduleRead());
    } catch (err) {
      this.opts.onError?.(err as Error);
    }
  }

  /**
   * fs.watch can fire multiple times for a single logical write. We coalesce:
   * if a read is already in progress, mark `pending` and chain another after.
   */
  private scheduleRead(): void {
    if (this.reading) {
      this.pending = true;
      return;
    }
    void this.readNew();
  }

  private async readNew(): Promise<void> {
    if (this.stopped) return;
    this.reading = true;
    try {
      const s = await stat(this.opts.path);
      if (s.size < this.offset) {
        // File was truncated/rotated — restart from current end.
        this.offset = s.size;
        this.buffer = '';
        return;
      }
      if (s.size === this.offset) return;

      const stream = createReadStream(this.opts.path, {
        start: this.offset,
        end: s.size - 1,
        encoding: 'utf8',
      });
      let chunk = this.buffer;
      for await (const buf of stream) {
        chunk += buf;
      }
      const lines = chunk.split('\n');
      // Last element is either an empty string (chunk ended with newline) or
      // a partial line; either way, keep it buffered for the next read.
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          await this.opts.onLine(line);
        } catch (err) {
          this.opts.onError?.(err as Error);
        }
      }
      this.offset = s.size;
    } catch (err) {
      this.opts.onError?.(err as Error);
    } finally {
      this.reading = false;
      if (this.pending && !this.stopped) {
        this.pending = false;
        void this.readNew();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
  }
}
