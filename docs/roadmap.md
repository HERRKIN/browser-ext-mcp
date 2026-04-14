# Roadmap

This document describes the path toward a browser workflow that feels close to Claude in Chrome, but built on top of your real Chrome session and exposed through MCP.

## Product Goal

Build an extension plus MCP bridge that can:

- control the user's real browser
- work with already-authenticated real sessions
- operate through workspace-scoped tab groups
- analyze pages, forms, responsive layouts, screenshots, network, console output, and DOM state
- automate multi-step flows with strong local guardrails
- remain extensible so new tools can be added later

## Principles

- do not depend on a parallel browser as the primary workflow
- use minimal permissions and per-site scoping
- separate personal browsing from agent browsing
- every new capability should enter as a clearly defined `tool`
- every sensitive action should require explicit approval

## Functional Model

### Core Entities

- `workspace`
- `workspace_tab_group`
- `workspace_tab`
- `workspace_run`
- `workspace_artifact`
- `tool_definition`
- `tool_execution_log`
- `site_permission`

### Operating Model

- every task lives inside a `workspace`
- every `workspace` can map to a `chrome.tabGroup`
- agent tabs live inside that group
- the MCP bridge only operates on the active workspace
- artifacts can include screenshots, DOM snapshots, logs, structured results, and comparisons

## Phases

## Phase 0. Technical Foundation

Goal: build a stable base for iteration.

Tasks:

- [x] initialize the repo and baseline documentation
- [x] create an MCP bridge over `stdio`
- [x] create an MV3 extension with a side panel
- [x] create the initial local relay
- [x] add a minimal bridge CLI (`status` / `start`)
- [x] detect an already-running relay instance
- [x] add short-range port fallback for the relay
- [ ] add shared typing between bridge and extension
- [ ] define a structured logging format
- [ ] define a stable tool error/result convention
- [ ] add development and extension-packaging scripts

## Phase 1. Workspaces And Tab Grouping

Goal: reproduce the "the agent opens its own tabs" model without a parallel browser.

Tasks:

- [x] create the `workspace` model
- [x] create the `workspace_tab_group` model
- [x] create `workspace_create`
- [x] create `workspace_list`
- [x] create `workspace_activate`
- [x] create `workspace_close`
- [x] create Chrome tab groups with names and colors
- [x] create a dedicated agent tab when a workspace is created
- [x] place new agent tabs inside the active group
- [x] list tabs from the current workspace
- [x] restrict tools to the active group
- [x] allow attaching an existing tab to a workspace
- [x] persist basic workspace metadata in `chrome.storage`

## Phase 2. Structured Page Reading

Goal: let the agent understand the page before acting.

Tasks:

- [x] stabilize `read_page`
- [x] generate persistent refs for elements
- [x] extract visible interactive elements
- [ ] extract summarized visible text
- [x] extract page metadata
- [x] extract landmarks and headings
- [x] add a summarized accessibility tree
- [x] support iframes when viable
- [ ] support deeper per-frame reading
- [x] create `find_elements`
- [x] create `highlight_elements`
- [x] create a cleaned DOM snapshot for debugging

## Phase 3. Reliable Interaction

Goal: fill forms and operate real UI with limited fragility.

Tasks:

- [x] harden `click`
- [x] harden `type`
- [x] create `clear_input`
- [x] create `form_fill`
- [x] create `select_option`
- [x] create `toggle_checkbox`
- [x] create `press_keys`
- [x] create `hover`
- [x] create `scroll`
- [x] create `wait_for`
- [x] create `upload_file`
- [ ] improve event dispatch for React/Vue/Angular
- [x] handle disabled/hidden/readonly elements
- [ ] add CDP fallback for interactions that fail with direct DOM access

## Phase 4. Screenshots And Visual Analysis

Goal: produce useful visual evidence for execution and debugging.

Tasks:

- [x] stabilize `screenshot_viewport`
- [x] create `screenshot_element`
- [x] create `screenshot_full_page`
- [x] create `screenshot_with_labels`
- [x] store artifacts with metadata
- [ ] define compression and resizing rules
- [ ] define bounding-box cropping conventions
- [ ] associate screenshots with `workspace_run`

## Phase 5. Responsive Design Analysis

Goal: inspect the same page across breakpoints and detect problems.

Tasks:

- [x] integrate `chrome.debugger`
- [x] create `emulate_viewport`
- [x] create mobile/tablet/desktop profiles
- [x] create `analyze_responsive_breakpoints`
- [x] detect horizontal overflow
- [x] detect clipping and out-of-viewport elements
- [ ] detect navigation/CTA changes by breakpoint
- [x] generate comparative breakpoint reports
- [x] attach screenshots per breakpoint

## Phase 6. Observability And Debugging

Goal: help debug real pages, not only click through them.

Tasks:

- [x] integrate CDP attach/detach per tab
- [x] create `get_console_logs`
- [x] create `start_network_capture`
- [x] create `stop_network_capture`
- [x] create `get_last_requests`
- [x] create `get_last_errors`
- [x] create `inspect_dom_node`
- [x] create `inspect_css_rules`
- [x] create `performance_snapshot`
- [ ] store logs per `workspace_run`

## Phase 7. Multi-Tab Workflows

Goal: coordinate multiple tabs inside the same workspace.

Tasks:

- [x] create `tab_open`
- [x] create `tab_focus`
- [x] create `tab_close`
- [x] create `tab_attach_to_workspace`
- [x] create `tab_group_list`
- [x] create `read_all_tabs_in_workspace`
- [x] create `collect_data_across_tabs`
- [ ] define navigation policy across tabs
- [ ] define concurrency limits

## Phase 8. Planning Mode And Approvals

Goal: avoid blind execution for ambiguous or sensitive actions.

Tasks:

- [ ] create a `plan_step` model
- [ ] show a plan before execution when appropriate
- [x] add approval flow in the side panel
- [ ] add `ask before acting`
- [ ] add `act within granted scope`
- [ ] require confirmation for sensitive actions
- [ ] record approvals and denials

## Phase 9. Local Security And Anti-Tampering

Goal: make it harder for another local process to take over the browser.

Tasks:

- [x] define the bridge-extension pairing protocol
- [x] generate an ephemeral per-session secret
- [x] require a Bearer token on the local relay
- [x] validate `Origin` and `Host`
- [x] bind strictly to `127.0.0.1`
- [x] expire inactive sessions
- [x] scope execution to the active workspace
- [ ] allow manual workspace locking
- [ ] require user presence for high-risk actions
- [x] document the threat model in more detail

## Phase 10. Site Permissions And Policy Controls

Goal: let the user control where the agent may act.

Tasks:

- [ ] create a `site_permission` store
- [ ] allow per-domain grants
- [ ] allow per-domain denies
- [x] allow allowlist/blocklist behavior
- [ ] support `optional_host_permissions`
- [ ] add UI to review and revoke permissions
- [ ] pre-block high-risk categories

## Phase 11. Scheduling And Deferred Runs

Goal: execute repeated tasks inside explicit limits.

Tasks:

- [ ] model scheduled jobs
- [ ] use `chrome.alarms`
- [ ] rehydrate a workspace for a scheduled job
- [ ] define allowed versus forbidden jobs
- [ ] add approval policy for scheduled tasks
- [ ] add complete logging and auditability

## Phase 12. Workflow Recording And Replay

Goal: turn repeated actions into reusable tools.

Tasks:

- [ ] record user/agent action sequences
- [ ] abstract selectors into stable refs
- [ ] store parameterized workflows
- [ ] create manual replay
- [ ] create scheduled replay
- [ ] handle failures and retry points

## Phase 13. Extensibility

Goal: let contributors add new tools without rewriting the core.

Tasks:

- [ ] define a declarative tool registry
- [ ] define shared input/output schemas
- [ ] separate bridge handlers from extension executors
- [ ] document how to create a new tool
- [ ] add custom tool examples
- [ ] evaluate a local plugin system

### Possible Future Improvement: Relay-Launched Local AI Clients

This is a possible future direction, not part of the current implementation plan.

Idea:

- let the extension send a user prompt to the local relay
- let the relay launch or reuse an installed local AI client such as `codex`, `claude`, `gemini`, or `opencode`
- let that selected client act as the reasoning engine and decide when to call the browser MCP tools
- optionally let the extension list which supported clients are installed locally so the user can choose an engine

Non-goals for this idea:

- do not require direct provider API keys in the extension
- do not turn the extension into a cloud-connected model client by default
- do not bypass the existing local guardrails around workspace scope, site policy, and approvals

Main requirements if this is explored later:

- a stable relay-side launcher or adapter layer for supported clients
- a clear request and response contract between extension and relay for chat turns, streaming, cancellation, and errors
- installation detection plus UI for selecting an available local client
- explicit separation between browser execution permissions and model-orchestration permissions
- careful process, token, and prompt-history handling so the extension does not gain broad implicit trust over local clients

## Definition Of Useful Parity

We will consider the project to have reached a first level of useful parity when it includes:

- a workspace with a dedicated tab group
- navigation and multi-tab work inside the workspace
- `read_page`, `find_elements`, `click`, `type`, `form_fill`
- viewport and full-page screenshots
- basic console and network capture
- responsive analysis across three breakpoints
- site permissions
- approval flow

## Current Operational Checklist

- [x] MCP bridge over `stdio`
- [x] local HTTP relay with signed `/health`
- [x] reuse of an existing bridge instance
- [x] automatic bridge port fallback
- [x] relay port autodiscovery in the extension
- [x] side panel with basic workspace management
- [x] agent isolation inside its own tab group
- [x] `navigate`, `read_page`, `click`, `type`, `tabs_list`
- [x] `clear_input`, `select_option`, `form_fill`, `press_keys`, `scroll`
- [x] `tab_open`, `tab_focus`, `tab_close`, `read_all_tabs_in_workspace`, `collect_data_across_tabs`
- [x] reusable local MCP client for tests and manual calls
- [x] bridge tests for reuse, conflict, and fallback
- [x] end-to-end coverage for dedicated workspace flow, multi-tab flow, forms, semantic search, and cleanup
- [~] `chrome.debugger`
- [x] local pairing/token

## Open Questions

- whether a manual `workspace lock` with a local passphrase is needed or ephemeral pairing is enough
- whether the bridge should auto-start or only run when the side panel is opened
- whether workspaces should persist long-term or default to temporary sessions
- whether a reverse-control mode should exist where the extension asks the relay to invoke an installed AI client, instead of requiring the user to start from that client over MCP
