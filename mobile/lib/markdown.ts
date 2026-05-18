export type MarkdownSegment =
  | { kind: 'text'; text: string }
  | { kind: 'inline_code'; text: string }
  | { kind: 'code_block'; lang: string | null; text: string };

/**
 * Lightweight, mobile-friendly markdown segmentation. Recognises fenced code
 * blocks (```lang\n...\n```) and inline code (`...`). Everything else stays
 * plain text. Intentionally not a full markdown parser — we just need to
 * separate code from prose so each renders with its own component.
 */
export function parseMarkdown(input: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(input)) !== null) {
    if (match.index > lastIndex) {
      pushInline(input.slice(lastIndex, match.index), segments);
    }
    const langRaw = (match[1] ?? '').trim();
    segments.push({
      kind: 'code_block',
      lang: langRaw.length > 0 ? langRaw : null,
      text: (match[2] ?? '').replace(/\n$/, ''),
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) {
    pushInline(input.slice(lastIndex), segments);
  }
  return segments.length ? segments : [{ kind: 'text', text: input }];
}

function pushInline(text: string, segments: MarkdownSegment[]): void {
  if (!text) return;
  const re = /`([^`\n]+)`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'inline_code', text: match[1] ?? '' });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
}
