# Troubleshooting

This guide covers the most common setup and runtime problems for `browser-ext-mcp`.

## Quick Triage

When something is not working, check these first:

1. `npm install` completed successfully
2. `npm run build --workspace bridge` completed successfully
3. the extension is loaded from `chrome://extensions`
4. the Browser Ext MCP side panel is open
5. the side panel shows `Connected`
6. the MCP client is exposing the `browser-ext-mcp` tools

## The Side Panel Says Offline

Symptoms:

- the side panel shows `Offline`
- MCP calls fail because the browser is not ready

Checks:

```bash
npm run bridge:status --workspace bridge
```

If the relay is not running, start it:

```bash
npm run bridge:start --workspace bridge
```

If you normally let the MCP client start the companion automatically, verify that the MCP server is registered correctly in your client.

Related doc:

- [llm-install.md](./llm-install.md)

## The MCP Client Does Not See The Tools

Symptoms:

- `workspace_list` or other tools are missing
- the client reports that the MCP server failed to launch

Checks:

1. rebuild the bridge:

```bash
npm run build --workspace bridge
```

2. verify the client registration points to the right command:

```bash
/absolute/path/to/node /absolute/path/to/browser-ext-mcp/bridge/dist/server.js
```

3. run:

```bash
npm run mcp:tools
```

If `mcp:tools` works locally but your client does not show the tools, the problem is usually in the client-side MCP registration.

## The Extension Is Loaded But Actions Fail

Symptoms:

- the side panel is connected
- the model can list tools
- page actions fail or do nothing

Checks:

1. make sure the target page is open in Chrome
2. make sure the agent session exists
3. refresh the side panel
4. confirm the page is not blocked by a site policy
5. check whether an approval is pending

If the page is open but the agent tabs look stale, close the session and let the agent create it again.

## The Wrong Relay Port Is Being Used

Symptoms:

- the side panel stays disconnected
- the client and extension appear to be talking to different relay instances

Checks:

- use the `Advanced` section in the side panel to inspect the relay port
- use:

```bash
npm run bridge:status --workspace bridge
```

If you intentionally changed the port, update the installer or set `BROWSER_EXT_RELAY_PORT`.

## Screenshots Or Debugger Tools Fail

Symptoms:

- screenshot tools fail
- DOM/CSS inspection works inconsistently
- console/network/performance tools fail

Checks:

1. confirm the page is still open
2. retry with the side panel open
3. make sure Chrome did not discard the target tab
4. rerun the action after focusing the target tab

The debugger-backed tools depend on Chrome tab state more than basic DOM reading does.

## Approvals Are Blocking Progress

Symptoms:

- actions appear to pause
- the model reports that approval is needed

Checks:

1. open the side panel
2. review the `Pending approvals` section
3. approve, deny, or update the current site policy

If you are doing repetitive low-risk work on the same site, adjusting the site policy may reduce friction.

## File Uploads Fail

Symptoms:

- `upload_file` fails
- the page does not receive the file

Checks:

1. confirm the target element is actually a file input
2. confirm the local file path exists
3. confirm the page has not re-rendered and invalidated the old ref

When in doubt, rerun `read_page` or `find_elements` and use a fresh ref.

## Responsive Analysis Looks Wrong

Symptoms:

- the report does not match what you expected
- artifacts exist but the issue is unclear

Checks:

1. run `analyze_responsive_breakpoints`
2. inspect the returned layout issues
3. fetch the stored artifacts when visual confirmation matters:

```bash
npm run mcp:call -- artifact_list
```

Then inspect the responsive snapshot artifact ids from the returned data.

## End-To-End Verification

If you want to verify the repo itself, run:

```bash
npm test
npm run typecheck
npm run test:e2e
```

## Known Limits

These are product limits, not setup bugs:

- Chrome/Chromium only
- no CAPTCHA or 2FA solving
- current iframe support is still partial
- permissions are still broader than the long-term target
- the local security model is not designed to defend a compromised machine
