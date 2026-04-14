# Install For AI Clients

This guide covers the main use case for this repo: terminal-based AI clients that need browser access through MCP.

`browser-ext-mcp` does not replace the extension. The AI client talks to the local MCP bridge, and the MV3 extension performs the actual work inside Chrome.

## Requirements

- Node.js 20+
- dependencies installed with `npm install`
- bridge built with `npm run build --workspace bridge`
- extension loaded from `extension/` in `chrome://extensions`
- side panel connected to the local relay

## Instructions For Other LLMs

You can copy this block directly into another model's instructions:

```text
To install browser-ext-mcp in a terminal-based MCP client:

1. Clone the repository and run:
   npm install
   npm run build --workspace bridge

2. Register an MCP server named browser-ext-mcp that launches:
   /absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js

3. Load the Chrome extension from /absolute/path/to/browser-ext-mcp/extension as an unpacked extension.

4. Open the extension side panel and connect it to the local relay.

5. Verify the setup by listing tools first, then calling workspace_list.

Do not claim the browser is ready until the extension is connected to the relay and the MCP server exposes the browser-ext-mcp tools.
```

## Automatic Installation

From the repo root:

```bash
npm run mcp:install
```

Useful options:

```bash
node scripts/install-mcp-clients.js --dry-run
node scripts/install-mcp-clients.js --clients=codex,claude
node scripts/install-mcp-clients.js --relay-port=8787
node scripts/install-mcp-clients.js --skip-build
```

By default the script tries to install into:

- `codex`
- `claude`
- `gemini`
- `opencode`

If a client is not installed locally, it is skipped without failing the run.

## Manual Installation Per Client

All manual variants use the same base command:

```bash
/absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js
```

Replace the absolute paths with your real local paths.

### Codex

```bash
codex mcp add browser-ext-mcp -- /absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js
```

### Claude Code

```bash
claude mcp add -s user browser-ext-mcp -- /absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js
```

### Gemini CLI

```bash
gemini mcp add -s user browser-ext-mcp /absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js
```

### OpenCode

OpenCode uses a global config file. Add an entry like this to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "browser-ext-mcp": {
      "type": "local",
      "enabled": true,
      "command": [
        "/absolute/path/to/node",
        "/absolute/path/to/browser-ext-mcp/bridge/dist/server.js"
      ]
    }
  }
}
```

## Minimal Verification

1. Start the bridge yourself or let the client start it.
2. Open the side panel and confirm that the extension is connected to the relay.
3. List the tools exposed by the MCP server.
4. Call `workspace_list`.
5. Create a workspace and test `navigate` or `read_page`.

## Notes

- if a relay is already running, the stdio bridge can reuse it
- if you change the relay port, use `--relay-port` in the installer or define `BROWSER_EXT_RELAY_PORT`
- if the AI client has no built-in browser extension support, this project fills that gap
