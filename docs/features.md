# Features

This is the current capability matrix for `browser-ext-mcp`, grouped by implementation status:

- `implemented`
- `in progress`
- `planned`

## Core Control

| Feature | Status | Notes |
| --- | --- | --- |
| Local MCP bridge over `stdio` | implemented | `bridge/src/server.ts` |
| Bridge CLI (`status` / `start`) | implemented | `bridge/src/cli.ts` |
| Local relay for the extension | implemented | `bridge/src/relay.ts` |
| Detection of an already-running relay | implemented | distinguishes own instance from a foreign process |
| Automatic bridge port fallback | implemented | scans a short port range if the default port is busy |
| MV3 side panel | implemented | `extension/sidepanel.*` |
| Real-browser execution | implemented | extension runs on real Chrome |
| Configurable relay port in the extension | implemented | UI plus persistence in `storage.local` |
| Relay port autodiscovery | implemented | local scan with `/health` signature validation |
| Local pairing and token flow | implemented | ephemeral per-session token; `/pull` and `/result` require Bearer auth |
| `tabs_list` | implemented | requires an active workspace and is scoped to the agent tab group |
| `navigate` | implemented | operates only inside the active workspace |
| `read_page` | implemented | base snapshot with interactive elements |
| `click` | implemented | acts through stable `ref` handles |
| `type` | implemented | uses native setters and `input/change/blur` events |
| `clear_input` | implemented | clears inputs and textareas by `ref` |
| `select_option` | implemented | supports `value`, `label`, or `index` |
| `form_fill` | implemented | fills multiple fields in a single call |
| `press_keys` | implemented | dispatches key sequences to the active target or a `ref` |
| `scroll` | implemented | scroll by delta with position feedback |
| `screenshot_viewport` | implemented | uses `captureVisibleTab` |

## Workspaces And Tabs

| Feature | Status | Notes |
| --- | --- | --- |
| `workspace_create` | implemented | creates a tab group with a dedicated agent tab and optional seed URL/tab |
| `workspace_list` | implemented | lists workspaces and associated tabs |
| `workspace_activate` | implemented | switches active context without hijacking a personal tab |
| `workspace_close` | implemented | can ungroup or close tabs and is exposed in the side panel |
| `tab_attach_to_workspace` | implemented | attaches an existing tab to the workspace group |
| `tab_open` | implemented | opens new tabs inside the workspace group |
| `tab_focus` | implemented | switches focus between workspace tabs |
| `tab_close` | implemented | closes tabs and cleans state when the last tab disappears |
| `read_all_tabs_in_workspace` | implemented | reads snapshots for every tab in the workspace |
| `collect_data_across_tabs` | implemented | aggregates semantic matches across workspace tabs using `find_elements`-style filters |
| Active-workspace scoping | implemented | reduces the risk of touching personal tabs |
| Side-panel workspace management | implemented | create, list, activate, close, and focus from the UI |
| Orphaned workspace cleanup | implemented | removes stale metadata when tabs/groups are closed externally |
| Workspace persistence | implemented | basic metadata plus relay port in `storage.local` |

## Forms And Advanced Interaction

| Feature | Status | Notes |
| --- | --- | --- |
| `form_fill` | implemented | supports text, selects, and checkboxes in batch |
| `select_option` | implemented | by `label`, `value`, or `index` |
| `toggle_checkbox` | implemented | toggles checkbox/radio by stable `ref` |
| `press_keys` | implemented | useful for `Enter`, `Tab`, and basic shortcuts |
| `hover` | implemented | dispatches hover events to the target element |
| `scroll` | implemented | basic page scrolling with feedback |
| `upload_file` | implemented | uploads local files into `<input type="file">` through the bridge |
| Interaction guards | implemented | validates visibility, `disabled`, and `readonly` before mutating |
| CDP fallback for hard interactions | planned | would rely on `chrome.debugger` |

## Reading And Analysis

| Feature | Status | Notes |
| --- | --- | --- |
| Visible interactive elements | implemented | base output of `read_page` |
| Page metadata | implemented | URL, title, viewport |
| Landmarks and headings | implemented | `read_page` returns visible landmarks and headings |
| Summarized accessibility tree | implemented | `get_accessibility_tree` returns roles, names, and refs |
| Iframes | partially implemented | `read_page` summarizes same-origin frames and `get_accessibility_tree` exposes them as document nodes |
| Clean DOM snapshot for debugging | implemented | `read_page` in `all` mode returns a cleaned `domSnapshot` |
| `find_elements` | implemented | filters interactive elements by role and label substring |
| `wait_for` | implemented | waits for a `ref`, selector, visible text, or interactive match |
| `highlight_elements` | implemented | overlays temporary highlights by role or label |

## Visual And Responsive

| Feature | Status | Notes |
| --- | --- | --- |
| Viewport screenshot | implemented | base64 data URL |
| Full-page screenshot | implemented | `screenshot_full_page` via `Page.captureScreenshot` |
| Element screenshot | implemented | `screenshot_element` crops via CDP bounding boxes |
| Labeled screenshot | implemented | `screenshot_with_labels` overlays refs temporarily |
| Viewport emulation | implemented | used internally by `analyze_responsive_breakpoints` |
| Breakpoint analysis | implemented | `mobile`, `tablet`, and `desktop` semantic snapshots plus an image snapshot for each breakpoint |
| Overflow and clipping detection | implemented | `layoutIssues` per profile |
| Activity overlay | implemented | pulsing blue overlay inside the page while MCP work is running |

## Observability And Debugging

| Feature | Status | Notes |
| --- | --- | --- |
| `chrome.debugger` integration | implemented | console, network, errors, metrics, screenshots, and responsive analysis |
| Console logs | implemented | per-tab buffer exposed by `get_console_logs` |
| Network capture | implemented | `start_network_capture`, `stop_network_capture`, `get_last_requests` |
| Page errors | implemented | `get_last_errors` combines runtime exceptions and `console.error` |
| DOM/CSS inspection | implemented | `inspect_dom_node` and `inspect_css_rules` reuse stable refs |
| Performance snapshot | implemented | `performance_snapshot` via `Performance.getMetrics` |

## Security

| Feature | Status | Notes |
| --- | --- | --- |
| Loopback-only relay | implemented | `127.0.0.1` |
| Workspace scoping | implemented | reduces blast radius |
| Ephemeral bridge-extension pairing | implemented | relay issues a local session |
| Session token | implemented | `/pull` and `/result` require Bearer auth |
| Site permissions | basic implementation | hostname policy with `allow`, `ask`, `block` |
| High-risk approval flow | basic implementation | pending actions can be approved or denied from the side panel or MCP |
| Allowlist/blocklist controls | basic implementation | `site_policy_set` exposes per-host policy |
| Permission minimization | planned | manifest still requests broad page access; `optional_host_permissions` remains future hardening |

## Advanced Automation

| Feature | Status | Notes |
| --- | --- | --- |
| Multi-tab workflows | in progress | foundation exists, richer coordination still missing |
| Planning mode | planned | not implemented yet |
| Scheduled tasks | planned | `chrome.alarms` is not wired to real jobs yet |
| Workflow recording | planned | not implemented yet |
| Workflow replay | planned | not implemented yet |
| Tool extensibility | in progress | MCP surface and bridge CLI exist; declarative registration is still missing |
| Persistent workspace artifacts | basic implementation | `artifact_list`, `artifact_get`, and `artifact_clear` manage stored snapshots and analysis reports |

## Current Practical Baseline

Today you can reliably:

- start and reuse the MCP bridge
- load the extension
- create an isolated workspace/tab group
- keep agent tabs separate from personal browsing
- scope the agent to that workspace
- list tabs and tab groups
- open, focus, and close workspace tabs
- navigate pages
- read page structure
- inspect the summarized accessibility tree with `get_accessibility_tree`
- search for elements with `find_elements`
- read every tab in the workspace
- collect semantic matches across tabs with `collect_data_across_tabs`
- click, type, clear inputs, select options, and fill forms
- press keys and scroll
- capture viewport, full-page, and element screenshots
- list persisted artifacts
- inspect console logs, DOM nodes, and CSS rules
- analyze responsive layout issues by breakpoint
- inspect one saved responsive snapshot artifact per breakpoint
- reconfigure or autodetect the relay port

Highest-value next steps:

1. deeper cross-frame reading and interaction
2. richer per-run payloads and attachments, not only metadata
3. `optional_host_permissions` and tighter permission reduction
