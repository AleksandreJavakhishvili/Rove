import { WebView } from 'react-native-webview';

interface Props {
  url: string;
  backgroundColor: string;
}

export function PreviewFrame({ url, backgroundColor }: Props) {
  return (
    <WebView
      source={{ uri: url }}
      style={{ flex: 1, backgroundColor }}
      startInLoadingState
      originWhitelist={['http://*', 'https://*']}
    />
  );
}
