import { uploadScreenshotPng, type UploadResult } from '@/lib/uploads';
import {
  SCREENSHOT_ERROR_REASON,
  type AgentKind,
  type ScreenshotErrorReason,
} from '@/lib/types';
import { useCallback, useRef, type RefObject } from 'react';
import { Platform, type View } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import type { PreviewFrameHandle } from '@/components/chat/PreviewFrame';
import { snapshotWebView } from 'rove-webview-snapshot';

/**
 * Typed error thrown by the capture hook so callers (the manual
 * shutter handler and the agent-initiated WS handler) can map a
 * failure straight onto a {@link ScreenshotErrorReason} without
 * string-matching `.message`.
 */
export class ScreenshotCaptureError extends Error {
  readonly reason: ScreenshotErrorReason;
  constructor(reason: ScreenshotErrorReason, message?: string) {
    super(message ?? reason);
    this.reason = reason;
    this.name = 'ScreenshotCaptureError';
  }
}

interface CaptureConfig {
  baseUrl: string;
  token?: string;
}

interface CapturePngResult {
  /** Raw PNG bytes as base64 (no data: prefix). */
  base64: string;
  /** Best-effort capture dimensions, used by the cost-meta line in Phase 3. */
  widthPx: number | null;
  heightPx: number | null;
}

interface CaptureOptions {
  /**
   * When supplied, iOS captures route through the native
   * `rove-webview-snapshot` module — which calls Apple's
   * `WKWebView.takeSnapshot(...)`. That API is sourced from the
   * WebKit content process so it returns pixel-accurate current
   * content, unlike `react-native-view-shot` which reads the host
   * compositor's cached layer (stale when the WebView has been
   * offscreen).
   *
   * Android still goes through view-shot's `targetRef` path because
   * Android's WebView is in-process and view-shot works correctly
   * there. Web is unsupported regardless.
   */
  previewFrameRef?: RefObject<PreviewFrameHandle | null>;
}

/**
 * Shared capture primitive for the visual-feedback-loop SDD. Both the
 * manual shutter and the agent-initiated MCP tool round-trip through
 * this hook so capture + upload semantics are identical regardless of
 * trigger.
 *
 * Returns a stable `ref` to attach to the wrapper View around the
 * PreviewPane WebView and two callables:
 *
 *   - `capture()`          → PNG base64 from the referenced subtree
 *   - `captureAndUpload()` → PNG base64 + UploadResult ready to attach
 *                            to a chat message
 *
 * The hook deliberately doesn't render any UI. The shutter / composer
 * own that.
 */
export function useScreenshotCapture(
  cfg: CaptureConfig,
  agent: AgentKind,
  sessionId: string,
  opts: CaptureOptions = {},
) {
  // Web target lacks a native captureRef implementation in
  // react-native-view-shot; the chat layer should not call the
  // shutter when `Platform.OS === 'web'`. We expose a typed error
  // here as a defense-in-depth fallback for callers that forget.
  const supported = Platform.OS === 'ios' || Platform.OS === 'android';
  const targetRef = useRef<View | null>(null);

  const capture = useCallback(async (): Promise<CapturePngResult> => {
    if (!supported) {
      throw new ScreenshotCaptureError(SCREENSHOT_ERROR_REASON.unsupported);
    }
    const started = Date.now();
    let base64: string | null = null;
    let pathTaken: 'native' | 'view-shot' = 'view-shot';
    // Preferred path on iOS: native WKWebView.takeSnapshot via our
    // custom module. Avoids the OOP-rendering layer-cache staleness
    // that view-shot suffers from. If the native module fails for
    // ANY reason — missing from the binary (dev hasn't rebuilt yet),
    // ref-lookup failure, WebView crash — we fall back to view-shot
    // and surface the native error as a debug log. This keeps the
    // capture pipeline working pre-rebuild; the only cost is the
    // pre-existing stale-pixel risk.
    const previewFrame = opts.previewFrameRef?.current;
    const nativeRef = previewFrame?.getNativeRef();
    const wantNative = Platform.OS === 'ios' && nativeRef !== undefined && nativeRef !== null;

    if (wantNative) {
      try {
        base64 = await snapshotWebView(nativeRef as Parameters<typeof snapshotWebView>[0], {
          fallbackRef: targetRef,
        });
        pathTaken = 'native';
      } catch (err) {
        // Most common cause pre-rebuild: requireNativeModule throws
        // because RoveWebViewSnapshot isn't linked into the binary
        // yet. Less common: WKWebView in a weird state. Either way,
        // fall through to view-shot below.
        if (__DEV__) {
          console.warn(
            `[screenshot] ${sessionId.slice(0, 8)} native takeSnapshot failed (${String((err as Error).message ?? err)}); falling back to view-shot`,
          );
        }
      }
    }

    if (base64 === null) {
      if (!targetRef.current) {
        throw new ScreenshotCaptureError(SCREENSHOT_ERROR_REASON.not_mounted);
      }
      try {
        base64 = await captureRef(targetRef.current, {
          format: 'png',
          quality: 1,
          result: 'base64',
        });
      } catch (err) {
        throw new ScreenshotCaptureError(
          SCREENSHOT_ERROR_REASON.capture_failed,
          String((err as Error).message ?? err),
        );
      }
    }
    if (__DEV__) {
      console.log(
        `[screenshot] ${sessionId.slice(0, 8)} ${pathTaken === 'native' ? 'native takeSnapshot' : 'view-shot captureRef'} took ${Date.now() - started}ms; bytes=${base64.length}`,
      );
    }
    return { base64, widthPx: null, heightPx: null };
  }, [supported, sessionId, opts.previewFrameRef]);

  const captureAndUpload = useCallback(async (): Promise<{
    upload: UploadResult;
    capture: CapturePngResult;
  }> => {
    const shot = await capture();
    const started = Date.now();
    let upload: UploadResult;
    try {
      upload = await uploadScreenshotPng(cfg, agent, sessionId, shot.base64);
    } catch (err) {
      throw new ScreenshotCaptureError(
        SCREENSHOT_ERROR_REASON.upload_failed,
        String((err as Error).message ?? err),
      );
    }
    if (__DEV__) {
      console.log(
        `[screenshot] ${sessionId.slice(0, 8)} upload took ${Date.now() - started}ms → ${upload.rel}`,
      );
    }
    return { upload, capture: shot };
  }, [capture, cfg, agent, sessionId]);

  return {
    /** Attach to the View wrapping the PreviewPane WebView. */
    targetRef,
    /** True when the current platform supports native capture. */
    supported,
    capture,
    captureAndUpload,
  };
}
