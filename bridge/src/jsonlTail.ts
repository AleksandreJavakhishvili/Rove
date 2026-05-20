import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { HistoryEntry } from './types.ts';

export interface JsonlTailOptions {
  path: string;
  /**
   * Called for each `HistoryEntry` parsed out of a freshly appended JSONL
   * line. The tail handles JSON.parse + entry normalization internally so
   * callers don't need a claude-code-specific parser of their own.
   */
  onEntry: (entry: HistoryEntry) => void | Promise<void>;
  /** Optional error sink. Failures don't stop the watcher. */
  onError?: (err: Error) => void;
}

/**
 * Translate one parsed JSONL entry from a claude session transcript into our
 * normalized `HistoryEntry[]`. Used only for the desktop-takeover jsonl-tail
 * path; the SDK's `getSessionMessages` covers everything else.
 *
 * Kept here (rather than importing from `agents/claudeCode.ts`) so the only
 * remaining hand-rolled claude-code JSONL parser lives in the CLI driver,
 * which is scheduled for deletion alongside this helper in a later phase.
 */
function parseTranscriptLine(obj: any): HistoryEntry[] {
  const ts = obj?.timestamp ?? new Date(0).toISOString();
  const uuid = obj?.uuid ?? `${ts}-${Math.random()}`;
  const parentUuid = obj?.parentUuid ?? null;
  const parentToolUseId: string | undefined =
    obj?.parentToolUseId ?? obj?.parent_tool_use_id ?? undefined;

  if (obj?.type === 'user' && obj.message?.role === 'user') {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      const out: HistoryEntry[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            uuid: `${uuid}:${block.tool_use_id}`,
            parentUuid,
            timestamp: ts,
            toolUseId: block.tool_use_id,
            content: block.content,
            isError: Boolean(block.is_error),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        } else if (block?.type === 'text') {
          out.push({
            kind: 'user',
            uuid,
            parentUuid,
            timestamp: ts,
            content: block.text,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
      return out;
    }
    return [
      {
        kind: 'user',
        uuid,
        parentUuid,
        timestamp: ts,
        content,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      },
    ];
  }

  if (obj?.type === 'assistant' && obj.message?.role === 'assistant') {
    const out: HistoryEntry[] = [];
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') {
          out.push({
            kind: 'assistant',
            uuid: `${uuid}:t`,
            parentUuid,
            timestamp: ts,
            content: block.text,
            ...(obj.message.model ? { model: obj.message.model } : {}),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        } else if (block?.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            uuid: `${uuid}:${block.id}`,
            parentUuid,
            timestamp: ts,
            name: block.name,
            input: block.input,
            toolUseId: block.id,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
      }
    } else if (typeof content === 'string') {
      out.push({
        kind: 'assistant',
        uuid,
        parentUuid,
        timestamp: ts,
        content,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
    }
    return out;
  }

  if (obj?.type === 'attachment' && obj.attachment) {
    return [
      {
        kind: 'system',
        uuid,
        timestamp: ts,
        subtype: obj.attachment.type ?? 'attachment',
        content: obj.attachment,
      },
    ];
  }
  return [];
}

/**
 * Tails a JSONL file. On start, seeks to the current end-of-file so previously
 * written lines are NOT replayed (assumes the caller already loaded history via
 * another path). On file changes, reads only the bytes that were appended
 * since the last read.
 *
 * `fs.watch` on a single file is plenty for this — the desktop-takeover
 * path is the only consumer.
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
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        for (const entry of parseTranscriptLine(obj)) {
          try {
            await this.opts.onEntry(entry);
          } catch (err) {
            this.opts.onError?.(err as Error);
          }
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
