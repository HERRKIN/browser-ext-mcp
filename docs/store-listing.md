# Chrome Web Store Listing Draft

This document contains draft copy and reviewer notes for the Chrome Web Store submission.

## Suggested Category

- `Developer Tools`

## Suggested Short Description

Control your real Chrome session from MCP-capable AI clients through a local companion and isolated agent tabs.

## Suggested Long Description

`browser-ext-mcp` connects MCP-capable AI clients to your real Chrome session.

It is designed for people who want browser workflows in tools like `Codex`, `Claude`, `Gemini`, or `OpenCode`, but want the agent to work inside the Chrome session they already use instead of a separate headless browser.

What the extension does:

- opens an agent-controlled browser session in isolated tabs
- reads real page structure and interactive elements
- fills forms and interacts with page controls
- captures screenshots and visual evidence
- inspects DOM, CSS, console logs, page errors, network activity, and performance data
- supports responsive layout review across multiple breakpoints

Important setup note:

This extension requires the local `browser-ext-mcp` companion from the GitHub repository. The extension is the browser-side component, and the local companion is what exposes the MCP server to supported AI clients.

Project repository:

- [github.com/HERRKIN/browser-ext-mcp](https://github.com/HERRKIN/browser-ext-mcp)

## Suggested Store Highlights

- Works with MCP-capable AI clients
- Uses your real Chrome session
- Keeps agent work isolated from your regular browsing
- Supports screenshots, debugging, and responsive analysis
- Local-first architecture with visible approvals and site policies

## Permissions Explanation Draft

These notes are useful both for the listing and for reviewer instructions.

### Why `debugger` is requested

The extension uses `chrome.debugger` for:

- full-page and element screenshots
- console log capture
- network request capture
- page error capture
- performance metrics
- responsive analysis

### Why `tabs` and `tabGroups` are requested

The extension isolates agent activity in dedicated browser tabs and tab groups, and needs to:

- open and focus agent tabs
- keep agent work separate from normal browsing
- close and clean up agent sessions

### Why `scripting` and broad host access are requested

The extension reads and interacts with real pages in Chrome. The current architecture uses page helpers and a global content script, so broad host access is still part of the current implementation.

### Why loopback access is requested

The extension communicates with a local companion over `127.0.0.1` / `localhost` so that an MCP-capable AI client can send browser tasks through the local machine.

## Reviewer Instructions Draft

1. Install the extension in Chrome.
2. Clone the repository:

```bash
git clone https://github.com/HERRKIN/browser-ext-mcp.git
cd browser-ext-mcp
```

3. Install and build the local companion:

```bash
npm install
npm run build --workspace bridge
```

4. Load the extension from `chrome://extensions` using `Load unpacked` and select the `extension/` folder.
5. Register the MCP companion:

```bash
npm run mcp:install
```

6. Open the Browser Ext MCP side panel in Chrome.
7. Confirm that the panel shows `Connected`.
8. Verify a basic workflow such as creating an agent session and reading a page.

## Support And Policy Links

- Support URL: GitHub repo homepage
- Privacy policy URL: publish [privacy-policy.md](./privacy-policy.md) to a stable public URL before submission
- Troubleshooting URL: [troubleshooting.md](./troubleshooting.md)

## Assets Still Needed

- extension icons
- store screenshots
- promo image
- optional demo GIF or short video
