import { parseInline, parseMarkdown } from '../parse';

describe('parseInline', () => {
  it('returns a single text span for plain text', () => {
    expect(parseInline('hello world')).toEqual([{ kind: 'text', text: 'hello world' }]);
  });

  it('parses bold', () => {
    expect(parseInline('a **bold** b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' b' },
    ]);
  });

  it('parses italic with asterisks', () => {
    expect(parseInline('a *italic* b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'italic', text: 'italic' },
      { kind: 'text', text: ' b' },
    ]);
  });

  it('parses italic with underscores', () => {
    expect(parseInline('a _italic_ b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'italic', text: 'italic' },
      { kind: 'text', text: ' b' },
    ]);
  });

  it('does not confuse single * inside **bold** for an italic close', () => {
    expect(parseInline('**Show HN:** prefix')).toEqual([
      { kind: 'bold', text: 'Show HN:' },
      { kind: 'text', text: ' prefix' },
    ]);
  });

  it('parses inline code', () => {
    expect(parseInline('use `npm install` to install')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: 'npm install' },
      { kind: 'text', text: ' to install' },
    ]);
  });

  it('does not interpret markdown inside inline code', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { kind: 'code', text: '**not bold**' },
    ]);
  });

  it('parses links with href and label', () => {
    expect(parseInline('see [docs](https://example.com) please')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', href: 'https://example.com', text: 'docs' },
      { kind: 'text', text: ' please' },
    ]);
  });

  it('treats [text]() with empty href as literal', () => {
    expect(parseInline('see [docs]() please')).toEqual([
      { kind: 'text', text: 'see [docs]() please' },
    ]);
  });

  it('falls back to text when a marker has no match', () => {
    expect(parseInline('this *is unmatched')).toEqual([
      { kind: 'text', text: 'this *is unmatched' },
    ]);
  });

  it('handles a string that starts and ends with formatting', () => {
    expect(parseInline('**a** and *b*')).toEqual([
      { kind: 'bold', text: 'a' },
      { kind: 'text', text: ' and ' },
      { kind: 'italic', text: 'b' },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseInline('')).toEqual([]);
  });
});

describe('parseMarkdown', () => {
  it('parses a single paragraph', () => {
    expect(parseMarkdown('hello world')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'hello world' }] },
    ]);
  });

  it('splits paragraphs on blank lines', () => {
    expect(parseMarkdown('one\n\ntwo')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'two' }] },
    ]);
  });

  it('keeps soft-wrapped lines in the same paragraph', () => {
    expect(parseMarkdown('one\ntwo')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one\ntwo' }] },
    ]);
  });

  it('does not duplicate trailing blank lines as empty paragraphs', () => {
    // This is the bug we hit with react-native-markdown-display: each trailing
    // newline becomes an empty paragraph that contributes ~17px of height,
    // inflating the bubble. Our parser must NOT emit empty paragraphs.
    const blocks = parseMarkdown('one\n\n\n\n');
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one' }] },
    ]);
  });

  it('treats lines containing only zero-width characters as blank', () => {
    // Claude occasionally emits runs of U+200B (ZWSP) / U+FEFF / U+200D etc.
    // after a code fence. They survive .trim() and previously slipped into
    // their own paragraphs, each rendering as line-height empty space that
    // could push a bubble hundreds of pixels tall. Treat them as blank lines.
    const src = 'real\n\n​\n​‍\n﻿\n\nmore';
    expect(parseMarkdown(src)).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'real' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'more' }] },
    ]);
  });

  it('strips zero-width characters embedded in paragraph text', () => {
    expect(parseMarkdown('hel​lo‌world')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'helloworld' }] },
    ]);
  });

  it('parses a fenced code block with language', () => {
    const src = 'before\n\n```ts\nconst x = 1;\n```\n\nafter';
    expect(parseMarkdown(src)).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'before' }] },
      { kind: 'fence', lang: 'ts', text: 'const x = 1;' },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'after' }] },
    ]);
  });

  it('parses a fenced code block without a language', () => {
    expect(parseMarkdown('```\nplain\n```')).toEqual([
      { kind: 'fence', lang: null, text: 'plain' },
    ]);
  });

  it('does not interpret markdown inside a fenced code block', () => {
    const src = '```\n**not bold**\n# not a heading\n```';
    expect(parseMarkdown(src)).toEqual([
      { kind: 'fence', lang: null, text: '**not bold**\n# not a heading' },
    ]);
  });

  it('handles an unterminated fence gracefully (no crash)', () => {
    const blocks = parseMarkdown('```ts\nconst x = 1;\n');
    expect(blocks).toEqual([{ kind: 'fence', lang: 'ts', text: 'const x = 1;' }]);
  });

  it('parses ATX headings of each level', () => {
    const src = '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6';
    const blocks = parseMarkdown(src);
    expect(blocks.map((b) => (b.kind === 'heading' ? b.level : b.kind))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('parses a bullet list with each marker', () => {
    const src = '- a\n* b\n+ c';
    expect(parseMarkdown(src)).toEqual([
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'text', text: 'a' }],
          [{ kind: 'text', text: 'b' }],
          [{ kind: 'text', text: 'c' }],
        ],
      },
    ]);
  });

  it('parses an ordered list', () => {
    const src = '1. first\n2. second\n10. tenth';
    expect(parseMarkdown(src)).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [
          [{ kind: 'text', text: 'first' }],
          [{ kind: 'text', text: 'second' }],
          [{ kind: 'text', text: 'tenth' }],
        ],
      },
    ]);
  });

  it('parses a horizontal rule', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'hr' }]);
    expect(parseMarkdown('***')).toEqual([{ kind: 'hr' }]);
  });

  it('parses inline formatting inside paragraphs', () => {
    expect(parseMarkdown('a **b** c')).toEqual([
      {
        kind: 'paragraph',
        spans: [
          { kind: 'text', text: 'a ' },
          { kind: 'bold', text: 'b' },
          { kind: 'text', text: ' c' },
        ],
      },
    ]);
  });

  it('handles a realistic Claude reply (paragraphs + bold + fenced code)', () => {
    const src = [
      'Yes — and arguably better than my "from anywhere" version for the HN crowd specifically.',
      '',
      'One critical fix: add **Show HN:** prefix. It is required.',
      '',
      'Final form:',
      '',
      '```',
      'Show HN: Rove – Vibe-code from your phone',
      '```',
      '',
      "That's the one to ship.",
    ].join('\n');

    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(5);
    expect(blocks[0]?.kind).toBe('paragraph');
    expect(blocks[1]?.kind).toBe('paragraph');
    expect(blocks[2]?.kind).toBe('paragraph');
    expect(blocks[3]).toEqual({
      kind: 'fence',
      lang: null,
      text: 'Show HN: Rove – Vibe-code from your phone',
    });
    expect(blocks[4]?.kind).toBe('paragraph');
  });

  it('normalises CRLF to LF', () => {
    expect(parseMarkdown('one\r\n\r\ntwo')).toEqual([
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'one' }] },
      { kind: 'paragraph', spans: [{ kind: 'text', text: 'two' }] },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseMarkdown('')).toEqual([]);
  });
});
