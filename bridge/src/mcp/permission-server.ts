/**
 * Standalone MCP stdio server that exposes a single `permission_prompt` tool.
 * Claude Code invokes this tool whenever it wants to use any non-allowed tool
 * (because we pass --permission-prompt-tool ...). We forward the request to the
 * bridge over HTTP; the bridge asks the phone; we relay the decision back to
 * Claude.
 *
 * Spawned by claude itself (not by the bridge directly) via --mcp-config.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BRIDGE_URL = process.env.BRIDGE_INTERNAL_URL;
const TOKEN = process.env.BRIDGE_INTERNAL_TOKEN;
const AGENT = process.env.ROVE_SESSION_AGENT ?? 'claude-code';
const SESSION_ID = process.env.ROVE_SESSION_ID ?? '';

if (!BRIDGE_URL || !TOKEN || !SESSION_ID) {
  console.error('[mcp permission-server] missing BRIDGE_INTERNAL_URL / BRIDGE_INTERNAL_TOKEN / ROVE_SESSION_ID');
  process.exit(2);
}

const server = new Server(
  { name: 'rove', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'permission_prompt',
      description: 'Ask the human (via their phone) whether to allow a tool invocation.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'permission_prompt') {
    return { content: [{ type: 'text', text: `unknown tool ${req.params.name}` }], isError: true };
  }
  const args = req.params.arguments as {
    tool_name: string;
    input?: unknown;
    tool_use_id?: string;
  };
  try {
    const res = await fetch(`${BRIDGE_URL}/internal/permission`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-internal-token': TOKEN!,
      },
      body: JSON.stringify({
        agent: AGENT,
        sessionId: SESSION_ID,
        toolUseId: args.tool_use_id ?? '',
        tool: args.tool_name,
        input: args.input ?? {},
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Claude expects a JSON string in the content. Returning a deny payload
      // signals refusal without crashing the session.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ behavior: 'deny', message: `bridge ${res.status}: ${body.slice(0, 200)}` }),
          },
        ],
      };
    }
    const decision = await res.json();
    return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            behavior: 'deny',
            message: `bridge unreachable: ${(err as Error).message}`,
          }),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error('[mcp permission-server] failed to start', err);
  process.exit(1);
});
