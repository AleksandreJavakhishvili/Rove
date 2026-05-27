/**
 * Validates the `path` argument an agent supplies to `take_screenshot`
 * (and, after the handoff SDD lands, the `suggestedPath` argument of
 * `prepare_preview`). Centralised so both SDDs share one rule.
 *
 * Accepts: a string starting with a single `/`, followed by a non-`/`
 * character, optionally followed by additional path segments, an
 * optional `?query`, and an optional `#fragment`.
 *
 * Rejects: empty (caller treats undefined as "current view"), absolute
 * URLs (`http:` / `https:` / scheme), protocol-relative (`//host/…`),
 * `..` traversal segments.
 */

export type PathValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function validatePreviewPath(input: string | undefined): PathValidation {
  // An empty input is the canonical "no path supplied" — the controller
  // treats it as "capture the current view" and never calls navigate.
  if (input === undefined || input === '') {
    return { ok: true, path: '' };
  }
  if (SCHEME_RE.test(input)) {
    return { ok: false, reason: 'absolute URL not allowed' };
  }
  if (input.startsWith('//')) {
    return { ok: false, reason: 'protocol-relative path not allowed' };
  }
  if (!input.startsWith('/')) {
    return { ok: false, reason: 'path must start with /' };
  }
  const pathPart = input.split(/[?#]/)[0] ?? '';
  if (pathPart.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'path traversal not allowed' };
  }
  return { ok: true, path: input };
}
