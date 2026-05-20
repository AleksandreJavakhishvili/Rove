/**
 * Minimal markdown parser for chat messages. Handles the subset that Claude
 * actually emits in conversation: paragraphs, fenced code blocks, ATX headings,
 * bullet/ordered lists, horizontal rules, and inline bold/italic/code/links.
 *
 * Returns plain tokens (no React) so the parser can be unit-tested without a
 * native runtime. The renderer lives separately in `render.tsx`.
 *
 * Limitations (intentional):
 *  - No tables, no images, no setext headings, no blockquotes (rare in chat).
 *  - No nested inline emphasis. `**`, `*`, `` ` `` and `[…](…)` produce flat
 *    spans whose contents are plain text — good enough for chat, and avoids
 *    the recursion that makes parsers explode.
 *  - HTML is treated as literal text.
 */

export interface ParagraphBlock {
  kind: 'paragraph';
  spans: Span[];
}
export interface FenceBlock {
  kind: 'fence';
  lang: string | null;
  text: string;
}
export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  spans: Span[];
}
export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: Span[][];
}
export interface HrBlock {
  kind: 'hr';
}

export type Block = ParagraphBlock | FenceBlock | HeadingBlock | ListBlock | HrBlock;

export interface TextSpan {
  kind: 'text';
  text: string;
}
export interface BoldSpan {
  kind: 'bold';
  text: string;
}
export interface ItalicSpan {
  kind: 'italic';
  text: string;
}
export interface CodeSpan {
  kind: 'code';
  text: string;
}
export interface LinkSpan {
  kind: 'link';
  href: string;
  text: string;
}

export type Span = TextSpan | BoldSpan | ItalicSpan | CodeSpan | LinkSpan;

// Zero-width / format characters that survive .trim() and slip past blank-line
// checks. Claude occasionally emits runs of these and they render as
// line-height empty space inside <Text>, inflating chat bubbles by hundreds of
// pixels. Stripped at parse time so the rest of the parser can stay simple.
// Covers U+200B–U+200D (ZWSP/ZWNJ/ZWJ), U+2060 (WJ), U+FEFF (BOM/ZWNBSP).
const INVISIBLE_CHARS = /[​-‍⁠﻿]/g;

function isBlank(line: string): boolean {
  return line.replace(INVISIBLE_CHARS, '').trim() === '';
}

/**
 * Parse markdown source into a flat list of block tokens. Whitespace at the
 * start/end of the source is trimmed; otherwise the parser does not normalize.
 */
export function parseMarkdown(source: string): Block[] {
  const cleaned = source.replace(INVISIBLE_CHARS, '');
  const lines = cleaned.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block: opening fence is ``` or ```lang. Close on the next
    // line that is exactly ``` (allowing trailing whitespace).
    const fenceOpen = line.match(/^```(.*)$/);
    if (fenceOpen) {
      const lang = (fenceOpen[1] ?? '').trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      // Skip closing fence if present. If we ran off the end without finding
      // one, we still emit the block — the user sees their unterminated code.
      if (i < lines.length) i += 1;
      // Trim trailing newlines from the body. Whether the input had a closing
      // fence or not, a hanging blank line at the end of code renders as ugly
      // empty space in `CodeBlock`.
      blocks.push({
        kind: 'fence',
        lang: lang.length > 0 ? lang : null,
        text: body.join('\n').replace(/\n+$/, ''),
      });
      continue;
    }

    // Blank line — flush any in-progress paragraph (handled implicitly below)
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    // Horizontal rule: a line of 3+ dashes/asterisks/underscores, possibly
    // with spaces between them.
    if (/^[\s]*([-*_])([\s]*\1){2,}[\s]*$/.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // ATX heading: 1-6 hashes followed by a space.
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, spans: parseInline(heading[2] ?? '') });
      i += 1;
      continue;
    }

    // Bullet list: lines starting with `- `, `* `, or `+ ` (followed by text).
    // We collect contiguous bullet lines.
    if (/^[\s]*[-*+]\s+/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^[\s]*[-*+]\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^[\s]*[-*+]\s+/, '');
        items.push(parseInline(itemText));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    // Ordered list: lines starting with `1. `, `2. `, etc.
    if (/^[\s]*\d+\.\s+/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^[\s]*\d+\.\s+/.test(lines[i]!)) {
        const itemText = lines[i]!.replace(/^[\s]*\d+\.\s+/, '');
        items.push(parseInline(itemText));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines.
    const buf: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i]!;
      if (isBlank(next)) break;
      if (/^```/.test(next)) break;
      if (/^#{1,6}\s+/.test(next)) break;
      if (/^[\s]*[-*+]\s+/.test(next)) break;
      if (/^[\s]*\d+\.\s+/.test(next)) break;
      if (/^[\s]*([-*_])([\s]*\1){2,}[\s]*$/.test(next)) break;
      buf.push(next);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(buf.join('\n')) });
  }

  return blocks;
}

/**
 * Parse a single line/paragraph of text into inline spans. The scanner walks
 * character-by-character so that overlapping delimiters resolve left-to-right
 * (the standard CommonMark fallback for ambiguous cases).
 *
 * Order of detection at each position:
 *   1. inline code `` `text` ``
 *   2. link `[label](url)`
 *   3. bold `**text**`
 *   4. italic `*text*` or `_text_`
 *   5. plain character → accumulate into a text span
 */
export function parseInline(source: string): Span[] {
  const out: Span[] = [];
  let buf = '';
  const flushText = () => {
    if (buf.length > 0) {
      out.push({ kind: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;

    // Inline code: greedy match of single-backtick run. We don't support
    // multi-backtick fences inline because chat content basically never uses
    // them.
    if (ch === '`') {
      const end = source.indexOf('`', i + 1);
      if (end > i) {
        flushText();
        out.push({ kind: 'code', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    // Link: [text](url). The text portion is plain (no nested formatting),
    // matching Claude's typical output.
    if (ch === '[') {
      const closeBracket = source.indexOf(']', i + 1);
      if (closeBracket > i && source[closeBracket + 1] === '(') {
        const closeParen = source.indexOf(')', closeBracket + 2);
        if (closeParen > closeBracket) {
          const label = source.slice(i + 1, closeBracket);
          const href = source.slice(closeBracket + 2, closeParen);
          // A link must have non-empty href; otherwise treat as literal text.
          if (href.length > 0) {
            flushText();
            out.push({ kind: 'link', href, text: label });
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    // Bold: **text**. Require at least one character between the markers.
    if (ch === '*' && source[i + 1] === '*') {
      const end = source.indexOf('**', i + 2);
      if (end > i + 2) {
        flushText();
        out.push({ kind: 'bold', text: source.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    // Italic: *text* or _text_. Require the closing marker to not be
    // immediately adjacent (handles `**` already consumed above; here we just
    // ensure single `*` doesn't swallow part of an unmatched bold).
    if ((ch === '*' || ch === '_') && source[i + 1] !== ch) {
      const end = source.indexOf(ch, i + 1);
      // Don't accept a match where the closing char is the start of `**`
      // (i.e., followed by another `*`) — that's still a bold marker we want
      // to leave alone.
      if (end > i + 1 && !(ch === '*' && source[end + 1] === '*')) {
        flushText();
        out.push({ kind: 'italic', text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flushText();
  return out;
}
