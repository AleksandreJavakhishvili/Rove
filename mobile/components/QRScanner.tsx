import { fontSize, radius, space, useTheme } from '@/theme';
import { CameraView, useCameraPermissions } from 'expo-camera';
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

export function QRScanner({ visible, onClose, onScan }: QRScannerProps) {
  const t = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  // Ref-based dedupe: state updates aren't synchronous between camera frames,
  // so we'd otherwise fire onScan multiple times for one QR.
  const scannedRef = useRef(false);
  const [scannedFlag, setScannedFlag] = useState(false); // for render-pause UI

  useEffect(() => {
    if (visible) {
      scannedRef.current = false;
      setScannedFlag(false);
    }
  }, [visible]);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: t.surface.base }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: t.text.primary }]}>Scan bridge QR</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={[styles.close, { color: t.accent.primary }]}>Close</Text>
          </Pressable>
        </View>

        {!permission ? (
          <View style={styles.center}>
            <ActivityIndicator />
          </View>
        ) : !permission.granted ? (
          <View style={styles.center}>
            <Text style={[styles.bodyText, { color: t.text.primary }]}>Camera permission needed.</Text>
            <Pressable
              onPress={requestPermission}
              style={[styles.primaryBtn, { backgroundColor: t.accent.primary }]}>
              <Text style={[styles.primaryBtnLabel, { color: t.accent.fg }]}>Grant access</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={
                scannedFlag
                  ? undefined
                  : (event) => {
                      if (scannedRef.current) return;
                      scannedRef.current = true;
                      setScannedFlag(true);
                      const data = event.data ?? '';
                      let parsed: ScannedConfig | null = null;
                      try {
                        const obj = JSON.parse(data);
                        if (obj && typeof obj.url === 'string') {
                          parsed = { url: obj.url, token: typeof obj.token === 'string' ? obj.token : undefined };
                        }
                      } catch {
                        if (/^https?:\/\//.test(data)) parsed = { url: data };
                      }
                      if (!parsed) {
                        // unrecognised QR — re-arm after a beat
                        setTimeout(() => {
                          scannedRef.current = false;
                          setScannedFlag(false);
                        }, 800);
                        return;
                      }
                      onScan(parsed);
                    }
              }
            />
            <View pointerEvents="none" style={styles.overlay}>
              <View style={styles.frame} />
              <Text style={styles.overlayText}>Aim at the QR printed by the bridge</Text>
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
  bodyText: { fontSize: fontSize.lg, textAlign: 'center' },
  primaryBtn: { paddingHorizontal: 22, paddingVertical: space[3], borderRadius: radius.lg + 2 },
  primaryBtnLabel: { fontWeight: '600' },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  frame: { width: 240, height: 240, borderColor: 'rgba(255,255,255,0.85)', borderWidth: 3, borderRadius: 16 },
  overlayText: {
    color: '#ffffff',
    fontSize: fontSize.base,
    marginTop: space[4],
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },
});
