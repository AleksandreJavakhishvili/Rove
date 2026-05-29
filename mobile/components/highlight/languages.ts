import { PrismLight } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import clike from 'react-syntax-highlighter/dist/esm/languages/prism/clike';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import graphql from 'react-syntax-highlighter/dist/esm/languages/prism/graphql';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import json5 from 'react-syntax-highlighter/dist/esm/languages/prism/json5';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import php from 'react-syntax-highlighter/dist/esm/languages/prism/php';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import ruby from 'react-syntax-highlighter/dist/esm/languages/prism/ruby';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import scss from 'react-syntax-highlighter/dist/esm/languages/prism/scss';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import swift from 'react-syntax-highlighter/dist/esm/languages/prism/swift';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

// Register base/dependency grammars (clike, markup, javascript) before the
// ones that extend them so refractor resolves their `require` chains.
const LANGUAGES: Record<string, unknown> = {
  clike,
  markup,
  javascript,
  typescript,
  jsx,
  tsx,
  json,
  json5,
  python,
  go,
  rust,
  java,
  c,
  cpp,
  css,
  scss,
  bash,
  yaml,
  sql,
  ruby,
  php,
  swift,
  kotlin,
  markdown,
  toml,
  diff,
  docker,
  graphql,
};

let registered = false;
/** Register the curated Prism grammars on the shared PrismLight instance.
 *  Idempotent — safe to call from every component mount. */
export function ensureLanguagesRegistered(): void {
  if (registered) return;
  for (const [name, grammar] of Object.entries(LANGUAGES)) {
    PrismLight.registerLanguage(name, grammar);
  }
  registered = true;
}

/** Map a file extension (lowercased, no dot) to a registered Prism language. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  json5: 'json5',
  jsonc: 'json5',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  markdown: 'markdown',
  toml: 'toml',
  diff: 'diff',
  patch: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
};

/** Filenames (no extension, or special) that imply a language. */
const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: 'docker',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
};

/** Resolve a Prism language id from a file path, or `null` if unknown
 *  (caller renders plain, un-highlighted text). */
export function languageForPath(path: string): string | null {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (FILENAME_TO_LANG[base]) return FILENAME_TO_LANG[base];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  return EXT_TO_LANG[ext] ?? null;
}
