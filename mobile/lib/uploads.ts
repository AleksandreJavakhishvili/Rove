import * as DocumentPicker from 'expo-document-picker';
// In expo-file-system v19 the imperative readAsStringAsync API moved to /legacy.
// We still need it because RN's fetch can't easily turn a file:// URI into base64.
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import type { AgentKind } from './types';

interface BridgeConfig {
  baseUrl: string;
  token?: string;
}

export interface UploadResult {
  /** Absolute path on the desktop. */
  path: string;
  /** Path relative to session cwd — what you paste into a user message. */
  rel: string;
  sizeBytes: number;
  isImage: boolean;
  mimeType: string;
}

async function readAsBase64(uri: string): Promise<string> {
  return await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
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

/**
 * Prompt the user to pick an image from the photo library, then upload it to
 * the bridge. Returns null if the user cancelled or permission was denied.
 */
export async function pickAndUploadImage(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('photo library permission denied');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.9,
    base64: true,
    exif: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0]!;
  const dataBase64 = asset.base64 ?? (await readAsBase64(asset.uri));
  const fileName = asset.fileName ?? `image-${Date.now()}.jpg`;
  return postUpload(cfg, agent, id, { fileName, mimeType: asset.mimeType, dataBase64 });
}

/**
 * Prompt the user to pick any document (text, code, PDF, etc.) and upload it.
 */
export async function pickAndUploadDocument(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0]!;
  const dataBase64 = await readAsBase64(asset.uri);
  return postUpload(cfg, agent, id, {
    fileName: asset.name,
    mimeType: asset.mimeType,
    dataBase64,
  });
}

/**
 * Take a fresh photo with the camera and upload it. Useful for "look at this
 * screenshot from another machine" or whiteboard photos.
 */
export async function captureAndUploadPhoto(
  cfg: BridgeConfig,
  agent: AgentKind,
  id: string,
): Promise<UploadResult | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('camera permission denied');
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    quality: 0.9,
    base64: true,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0]!;
  const dataBase64 = asset.base64 ?? (await readAsBase64(asset.uri));
  const fileName = asset.fileName ?? `photo-${Date.now()}.jpg`;
  return postUpload(cfg, agent, id, { fileName, mimeType: asset.mimeType, dataBase64 });
}
