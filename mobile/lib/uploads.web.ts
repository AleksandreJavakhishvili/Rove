import type { AgentKind } from './types';

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

export interface UploadResult {
  path: string;
  rel: string;
  sizeBytes: number;
  isImage: boolean;
  mimeType: string;
}

async function postUpload(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  payload: { fileName: string; mimeType?: string; dataBase64: string },
): Promise<UploadResult> {
  const res = await fetch(`${cfg.baseUrl}/sessions/${encodeURIComponent(agent)}/${id}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`upload failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as UploadResult;
}

function pickFile(opts: { accept?: string; capture?: 'user' | 'environment' }): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);

    let settled = false;
    const settle = (file: File | null) => {
      if (settled) return;
      settled = true;
      try {
        document.body.removeChild(input);
      } catch {
        /* already removed */
      }
      resolve(file);
    };

    input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true });
    // `cancel` fires on modern Chromium and recent Safari when the user
    // dismisses the picker. Older browsers don't fire it — for those we fall
    // back to a focus-based heuristic.
    input.addEventListener('cancel', () => settle(null), { once: true });
    const onFocus = () => {
      // Give `change` a tick to fire before assuming cancellation.
      setTimeout(() => settle(null), 400);
    };
    window.addEventListener('focus', onFocus, { once: true });

    input.click();
  });
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

async function uploadFile(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
  file: File,
  fallbackName: string,
): Promise<UploadResult> {
  const dataBase64 = await fileToBase64(file);
  return postUpload(cfg, agent, id, {
    fileName: file.name || fallbackName,
    mimeType: file.type || undefined,
    dataBase64,
  });
}

export async function pickAndUploadImage(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  const file = await pickFile({ accept: 'image/*' });
  if (!file) return null;
  return uploadFile(cfg, agent, id, file, `image-${Date.now()}.jpg`);
}

export async function pickAndUploadDocument(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  const file = await pickFile({});
  if (!file) return null;
  return uploadFile(cfg, agent, id, file, `file-${Date.now()}`);
}

export async function captureAndUploadPhoto(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  // `capture=environment` is a hint to mobile browsers to open the camera UI
  // directly. On desktop browsers it's ignored and the standard file picker
  // opens — which is fine, that's a desktop user's only path to a camera shot
  // anyway.
  const file = await pickFile({ accept: 'image/*', capture: 'environment' });
  if (!file) return null;
  return uploadFile(cfg, agent, id, file, `photo-${Date.now()}.jpg`);
}
