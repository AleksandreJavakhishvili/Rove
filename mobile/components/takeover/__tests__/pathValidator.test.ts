import { validatePreviewPath } from '../pathValidator';

describe('validatePreviewPath', () => {
  it('treats undefined as the no-path / current-view sentinel', () => {
    expect(validatePreviewPath(undefined)).toEqual({ ok: true, path: '' });
  });

  it('treats empty string as the no-path sentinel', () => {
    expect(validatePreviewPath('')).toEqual({ ok: true, path: '' });
  });

  it('accepts a single-slash relative path', () => {
    expect(validatePreviewPath('/about')).toEqual({ ok: true, path: '/about' });
  });

  it('accepts paths with query strings and fragments', () => {
    expect(validatePreviewPath('/dash?tab=overview#summary')).toEqual({
      ok: true,
      path: '/dash?tab=overview#summary',
    });
  });

  it('rejects absolute URLs (http)', () => {
    const out = validatePreviewPath('http://evil.com/');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/absolute URL/);
  });

  it('rejects absolute URLs (https)', () => {
    expect(validatePreviewPath('https://x.example')).toMatchObject({ ok: false });
  });

  it('rejects javascript: pseudo-protocol', () => {
    expect(validatePreviewPath('javascript:alert(1)')).toMatchObject({ ok: false });
  });

  it('rejects protocol-relative URLs', () => {
    const out = validatePreviewPath('//evil.com/admin');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/protocol-relative/);
  });

  it('rejects bare segments without a leading slash', () => {
    const out = validatePreviewPath('about');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/must start with/);
  });

  it('rejects path traversal segments', () => {
    const out = validatePreviewPath('/foo/../etc/passwd');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/traversal/);
  });

  it('rejects pure traversal', () => {
    expect(validatePreviewPath('/..')).toMatchObject({ ok: false });
  });
});
