/**
 * Minimal line-level diff: returns a unified-diff-ish sequence of operations.
 * Good enough for displaying Edit / MultiEdit / Write outputs on mobile, where
 * we mostly want red/green tinted lines rather than a perfect Myers diff.
 *
 * Strategy: split both sides by line, find the longest common prefix and
 * suffix, mark the middle as removed/added. For most Edit tool calls the
 * old_string and new_string differ only in the middle, so this is accurate.
 * For multi-line block reorderings it degrades to "whole block changed",
 * which is fine for a preview.
 */

export type DiffLine =
  | { op: 'context'; line: string; oldNo: number; newNo: number }
  | { op: 'remove'; line: string; oldNo: number }
  | { op: 'add'; line: string; newNo: number };

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
}

export function diffStrings(oldStr: string, newStr: string): DiffResult {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  // Show up to 2 lines of context before
  const ctxStart = Math.max(0, prefix - 2);
  for (let i = ctxStart; i < prefix; i++) {
    out.push({ op: 'context', line: oldLines[i] ?? '', oldNo: i + 1, newNo: i + 1 });
    oldNo = i + 1;
    newNo = i + 1;
  }

  // Removed lines
  let removed = 0;
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    out.push({ op: 'remove', line: oldLines[i] ?? '', oldNo: i + 1 });
    oldNo = i + 1;
    removed += 1;
  }

  // Added lines
  let added = 0;
  for (let i = prefix; i < newLines.length - suffix; i++) {
    out.push({ op: 'add', line: newLines[i] ?? '', newNo: i + 1 });
    newNo = i + 1;
    added += 1;
  }

  // Show up to 2 lines of context after
  const ctxEndStart = oldLines.length - suffix;
  const ctxEndEnd = Math.min(ctxEndStart + 2, oldLines.length);
  for (let i = ctxEndStart; i < ctxEndEnd; i++) {
    out.push({
      op: 'context',
      line: oldLines[i] ?? '',
      oldNo: i + 1,
      newNo: i - ctxEndStart + newNo + 1,
    });
  }

  return { lines: out, added, removed };
}
