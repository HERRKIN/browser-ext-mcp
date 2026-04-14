# browser-ext-mcp

`browser-ext-mcp` gives an MCP-capable AI client access to your real Chrome session through a Chrome extension plus a local companion.

It is built for the case where the agent should work in the browser you already use, not in a parallel headless browser.

## Why This Exists

The original inspiration was the browser workflow around `Claude Desktop` and `Claude in Chrome`.

That experience gets an important thing right: the model can actually see and operate inside the browser session you are already using. It can inspect live pages, read what is on screen, fill forms, and work in context instead of in a separate automation sandbox.

I wanted that same core capability for MCP-based clients such as `codex`, `claude`, `gemini`, or `opencode`, without making Chrome control belong to only one product.

## What It Is

- Chrome MV3 extension with a side panel
- local MCP companion over `stdio`
- agent-isolated browser tabs backed by workspaces/tab groups
- real-page reading, interaction, screenshots, logs, network capture, and responsive analysis

The extension does not work by itself. It needs the local companion from this repo.

Repo:
- [github.com/HERRKIN/browser-ext-mcp](https://github.com/HERRKIN/browser-ext-mcp)

License:
- [MIT](./LICENSE)

## Quickstart

### 1. Install and build

```bash
npm install
npm run build --workspace bridge
```

### 2. Load the extension in Chrome

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the [`extension`](./extension) folder

### 3. Register the MCP companion

Automatic install into supported local clients:

```bash
npm run mcp:install
```

Manual client setup and examples:
- [docs/llm-install.md](./docs/llm-install.md)

### 4. Open the side panel

The normal flow is:

- open the Browser Ext MCP side panel
- let the agent prepare its own session
- review agent tabs, focus them, or close the session

## A Few Useful Commands

Inspect the exposed MCP tools:

```bash
npm run mcp:tools
```

Call one tool directly:

```bash
npm run mcp:call -- workspace_list
```

If you are debugging the local relay itself:

```bash
npm run bridge:status --workspace bridge
npm run bridge:start --workspace bridge
```

## Current Status

This repo is already usable for local technical users.

- bridge tests and e2e coverage are green
- real-page interaction, screenshots, DOM/CSS inspection, logs, network capture, and responsive analysis are working
- the extension now presents the browser state as an agent session instead of exposing more infrastructure than necessary

What is not being claimed yet:

- minimized extension permissions
- hardened security for a hostile local machine
- polished one-click distribution through the Chrome Web Store plus a packaged companion
- higher-level workflow recording or automation

## Limitations

- Chrome/Chromium only
- no CAPTCHA or 2FA solving
- not designed to evade anti-bot systems
- local-first security model, not a remote multi-user service

## Documentation

Use the docs when you want detail beyond the quickstart.

- [docs/index.md](./docs/index.md): documentation map and suggested reading order
- [docs/examples.md](./docs/examples.md): concrete tasks, prompt examples, and model usage patterns
- [docs/llm-install.md](./docs/llm-install.md): MCP setup for `codex`, `claude`, `gemini`, `opencode`, and similar clients
- [docs/troubleshooting.md](./docs/troubleshooting.md): common setup and runtime problems
- [docs/privacy-policy.md](./docs/privacy-policy.md): privacy policy draft for public distribution
- [docs/chrome-web-store.md](./docs/chrome-web-store.md): listing and submission prep for the Chrome Web Store
- [docs/features.md](./docs/features.md): capability matrix and current implementation status
- [docs/security.md](./docs/security.md): threat model, current guardrails, and remaining hardening work
- [docs/publishing.md](./docs/publishing.md): release checklist and public-release posture
- [docs/roadmap.md](./docs/roadmap.md): longer-term technical and product direction
