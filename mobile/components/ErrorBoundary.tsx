import { Component, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  /** Short name shown in the fallback + logged, so you know which subtree threw. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Minimal class error boundary used to localize a suspected-crashing surface
 * while debugging. It's a JS-vs-native discriminator:
 *
 *  - If the fallback renders, the crash was a JS render/lifecycle throw — and
 *    `componentDidCatch` logs the message + component stack so we can see it.
 *  - If the app STILL hard-closes (no fallback), the crash is native — UI
 *    thread / Reanimated / gesture-handler — and must be read from the native
 *    log (Xcode console or `adb logcat`), not the JS console.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary:${this.props.label}] ${error?.message}\n${info?.componentStack ?? ''}`,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.box}>
          <Text style={styles.text}>
            {this.props.label} crashed: {this.state.error.message}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  box: { padding: 12, alignItems: 'center', justifyContent: 'center' },
  text: { color: '#f87171', fontSize: 12, textAlign: 'center' },
});
