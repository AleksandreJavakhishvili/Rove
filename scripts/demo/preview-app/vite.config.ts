import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `host: true`            → bind to 0.0.0.0 so Rove's preview-pane scanner
//                           on the bridge can reach the dev server from your phone.
// `allowedHosts: true`    → Vite 5+ blocks requests whose Host header isn't
//                           in an allowlist by default (CVE mitigation). The
//                           Rove preview pane connects via your Tailscale
//                           hostname (e.g. macbook.tailnet.ts.net:5173), so
//                           we need to accept any host here.
//
// Both relaxations are fine for a demo app on a private tailnet. Don't copy
// this config into anything you'd expose to the public internet.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    allowedHosts: true,
  },
});
