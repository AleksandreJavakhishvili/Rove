import WebSocket from 'ws';

const sessionId = process.argv[2];
const sendMessage = process.argv[3];
const agent = process.env.AGENT ?? 'claude-code';
const baseUrl = process.env.BRIDGE_URL ?? 'ws://127.0.0.1:8443';

if (!sessionId) {
  console.error('Usage: tsx scripts/smoke-ws.ts <session-id> [message-to-send]');
  console.error('Env: AGENT (default claude-code), BRIDGE_URL (default ws://127.0.0.1:8443)');
  process.exit(1);
}

const ws = new WebSocket(`${baseUrl}/sessions/${agent}/${sessionId}/stream`);
let entryCount = 0;
let eventCount = 0;
let history_done = false;

ws.on('open', () => {
  console.error(`[smoke] connected to ${sessionId}`);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'history_replay_start') {
    console.error('[smoke] history replay start');
  } else if (msg.type === 'history_entry') {
    entryCount += 1;
    if (entryCount <= 3) {
      console.error(`[smoke] history #${entryCount}: ${msg.entry.kind} ${msg.entry.timestamp ?? ''}`);
    }
  } else if (msg.type === 'history_replay_end') {
    history_done = true;
    console.error(`[smoke] history replay end (${entryCount} entries)`);
    if (sendMessage) {
      console.error(`[smoke] sending user_message: ${sendMessage.slice(0, 80)}`);
      ws.send(JSON.stringify({ type: 'user_message', content: sendMessage }));
    } else {
      console.error('[smoke] no message arg — closing');
      ws.close();
    }
  } else if (msg.type === 'status') {
    console.error(`[smoke] status: ${msg.status} pid=${msg.pid ?? '-'}`);
  } else if (msg.type === 'event') {
    eventCount += 1;
    const evType = (msg.event as any)?.type ?? 'unknown';
    if (eventCount <= 20) console.error(`[smoke] event #${eventCount} type=${evType}`);
    if (evType === 'result') {
      console.error(`[smoke] result received — closing`);
      setTimeout(() => ws.close(), 200);
    }
  } else if (msg.type === 'process_exit') {
    console.error(`[smoke] process exited code=${msg.code} signal=${msg.signal}`);
  } else if (msg.type === 'error') {
    console.error(`[smoke] error: ${msg.message}`);
  } else {
    console.error(`[smoke] msg: ${JSON.stringify(msg).slice(0, 200)}`);
  }
});

ws.on('close', (code, reason) => {
  console.error(`[smoke] socket closed (code=${code}, reason=${reason.toString()})`);
  console.error(`[smoke] summary: history_done=${history_done} entries=${entryCount} events=${eventCount}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error(`[smoke] socket error: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('[smoke] timeout reached, closing');
  ws.close();
}, 120000).unref();
