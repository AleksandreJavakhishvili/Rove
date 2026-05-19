import { fontSize, radius, space, useTheme } from '@/theme';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

export interface ScannedConfig {
  url: string;
  token?: string;
}

interface QRScannerProps {
  visible: boolean;
  onClose: () => void;
  onScan: (config: ScannedConfig) => void;
}

type DetectorState = 'idle' | 'starting' | 'scanning' | 'denied' | 'unavailable' | 'error';

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return w.BarcodeDetector ?? null;
}

function parsePayload(raw: string): ScannedConfig | null {
  try {
    const obj = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (obj && typeof obj.url === 'string') {
      return { url: obj.url, token: typeof obj.token === 'string' ? obj.token : undefined };
    }
  } catch {
    if (/^https?:\/\//.test(raw)) return { url: raw };
  }
  return null;
}

export function QRScanner({ visible, onClose, onScan }: QRScannerProps) {
  const t = useTheme();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const scannedRef = useRef(false);
  const [state, setState] = useState<DetectorState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    scannedRef.current = false;
    setErrorMessage(null);

    const Detector = getBarcodeDetectorCtor();
    if (!Detector) {
      setState('unavailable');
      return;
    }

    setState('starting');
    let cancelled = false;
    const detector = new Detector({ formats: ['qr_code'] });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setState('scanning');

        const tick = async () => {
          if (cancelled || scannedRef.current) return;
          try {
            const codes = await detector.detect(video);
            for (const code of codes) {
              const parsed = parsePayload(code.rawValue ?? '');
              if (parsed) {
                scannedRef.current = true;
                onScan(parsed);
                return;
              }
            }
          } catch {
            // Transient decode failure — just try the next frame.
          }
          rafRef.current = window.requestAnimationFrame(() => void tick());
        };
        rafRef.current = window.requestAnimationFrame(() => void tick());
      } catch (err) {
        if (cancelled) return;
        const e = err as Error;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
          setState('denied');
        } else {
          setState('error');
          setErrorMessage(e.message);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
  }, [visible, onScan]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: t.surface.base }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: t.text.primary }]}>Scan bridge QR</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={[styles.close, { color: t.accent.primary }]}>Close</Text>
          </Pressable>
        </View>

        {state === 'unavailable' ? (
          <View style={styles.center}>
            <Text style={[styles.bodyText, { color: t.text.primary }]}>
              This browser doesn&apos;t expose a QR scanner. Close this and paste the URL + token by
              hand — they&apos;re printed in your `rove-bridge` terminal alongside the QR code.
            </Text>
          </View>
        ) : state === 'denied' ? (
          <View style={styles.center}>
            <Text style={[styles.bodyText, { color: t.text.primary }]}>
              Camera permission denied. Allow camera access in the browser&apos;s site settings, or
              close this dialog and paste the URL + token manually.
            </Text>
          </View>
        ) : state === 'error' ? (
          <View style={styles.center}>
            <Text style={[styles.bodyText, { color: t.text.primary }]}>
              Camera couldn&apos;t start: {errorMessage ?? 'unknown error'}.
            </Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                backgroundColor: '#000',
              }}
            />
            <View pointerEvents="none" style={styles.overlay}>
              <View style={styles.frame} />
              <Text style={styles.overlayText}>
                {state === 'starting' ? 'Starting camera…' : 'Aim at the QR printed by the bridge'}
              </Text>
              {state === 'starting' ? <ActivityIndicator color="#ffffff" /> : null}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: space[4],
    paddingTop: 56,
    paddingBottom: space[3],
  },
  title: { fontSize: fontSize['2xl'], fontWeight: '600' },
  close: { fontSize: fontSize.lg, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[4], padding: space[6] },
  bodyText: { fontSize: fontSize.lg, textAlign: 'center', lineHeight: 24 },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: space[3] },
  frame: { width: 240, height: 240, borderColor: 'rgba(255,255,255,0.85)', borderWidth: 3, borderRadius: 16 },
  overlayText: {
    color: '#ffffff',
    fontSize: fontSize.base,
    marginTop: space[4],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
});
