# Examples And Prompt Patterns

This document shows what `browser-ext-mcp` is good at, how to ask for it, and how the model should generally use the MCP tools to get reliable results.

## Default Operating Pattern

For most tasks, the model should follow this sequence:

1. Prepare or reuse the agent session.
2. Open or focus the relevant tab.
3. Read the page before acting.
4. Use stable refs or structured data instead of blind clicking.
5. Wait for the UI when needed.
6. Capture evidence when the user wants verification, screenshots, or diagnostics.

In practice, that usually means:

- `workspace_create` or reuse the active session
- `navigate` or `tab_open`
- `read_page` or `read_all_tabs_in_workspace`
- `find_elements` only when labels/roles matter
- `click`, `type`, `form_fill`, `select_option`, `toggle_checkbox`, `press_keys`
- `wait_for` after async UI changes
- `screenshot_viewport`, `screenshot_full_page`, `inspect_dom_node`, `inspect_css_rules`, `get_console_logs`, `analyze_responsive_breakpoints` when verification matters

## Example: Fill A Real Form

Prompt:

> Open the signup page, fill the form with sensible dummy data, and stop before the final submit button.

Good model behavior:

1. Open or prepare an agent session for the target page.
2. Use `read_page` with `interactive` mode to understand the form.
3. Use `form_fill` when multiple fields can be filled in one pass.
4. Use `select_option` or `toggle_checkbox` only when needed.
5. Stop before clearly destructive or final confirmation actions unless the user explicitly asked to continue.

Typical tool flow:

- `workspace_create`
- `read_page`
- `form_fill`
- `select_option`
- `toggle_checkbox`
- `wait_for`

## Example: Review Responsive Design

Prompt:

> Check this page on desktop, tablet, and mobile. Tell me if anything overflows, clips, or breaks visually.

Good model behavior:

1. Open the page in an agent session.
2. Run `analyze_responsive_breakpoints`.
3. Report the breakpoint-level findings first.
4. Pull artifact snapshots only if the model needs the actual captured images for inspection.

Typical tool flow:

- `workspace_create`
- `analyze_responsive_breakpoints`
- `artifact_list`
- `artifact_get`

Expected output shape:

- which breakpoints were checked
- whether horizontal overflow exists
- whether content is clipped
- which visible sections are affected

## Example: Inspect A Live UI Bug

Prompt:

> Open the page, inspect the broken card layout, and tell me whether the issue is DOM structure, CSS, or data.

Good model behavior:

1. Read the page first.
2. Locate the relevant element with `find_elements` or from `read_page`.
3. Use `inspect_dom_node` and `inspect_css_rules` on the specific element, not the whole page.
4. Pull `get_console_logs` or `get_last_errors` if the page also looks broken at runtime.

Typical tool flow:

- `read_page`
- `find_elements`
- `inspect_dom_node`
- `inspect_css_rules`
- `get_console_logs`
- `get_last_errors`

## Example: Repetitive Backoffice Task

Prompt:

> Go through the open admin queue, open each item, collect the customer email and status, and return a clean summary table.

Good model behavior:

1. Work inside the agent session, not the user's browsing tabs.
2. Use `read_all_tabs_in_workspace` and `collect_data_across_tabs` when multiple tabs are already open.
3. Prefer structured extraction over screenshots.
4. Ask for confirmation before irreversible actions or final submission flows.

Typical tool flow:

- `workspace_create`
- `tab_open`
- `read_page`
- `click`
- `wait_for`
- `collect_data_across_tabs`

## Example: Capture Evidence For A Review

Prompt:

> Open the settings page, check the current state, and include screenshots for the main issue.

Good model behavior:

1. Read the page and understand the current state.
2. Capture only the screenshots that support the answer.
3. Use `screenshot_element` when the issue is local to one control or section.
4. Use `screenshot_full_page` only when page context matters.

Typical tool flow:

- `read_page`
- `screenshot_element`
- `screenshot_viewport`
- `screenshot_full_page`

## Example: Multi-Tab Research In One Session

Prompt:

> Open the docs page, the pricing page, and the changelog, then summarize the differences that matter for a buyer.

Good model behavior:

1. Keep all tabs in the same agent session.
2. Use `tab_open` for each page.
3. Use `read_all_tabs_in_workspace` to summarize each tab.
4. Only drill into specific tabs when needed.

Typical tool flow:

- `workspace_create`
- `tab_open`
- `read_all_tabs_in_workspace`
- `tab_focus`
- `read_page`

## Prompt Writing Tips

Prompts work best when they specify:

- the target site or page
- the goal
- whether the model should stop before submit or destructive actions
- whether screenshots or evidence are required
- whether the output should be summary, table, checklist, or recommendation

Good prompts:

- `Open the billing page, tell me what plan is active, and capture one screenshot of the subscription section.`
- `Review this landing page on desktop and mobile and list the top three responsive issues.`
- `Fill the onboarding form with placeholder data and stop before the final submit action.`
- `Inspect this broken button and tell me whether the issue comes from CSS, DOM state, or a console error.`

Weak prompts:

- `Check this site`
- `Do the thing in the browser`
- `Analyze this page`

## Guidance For Model Authors

If you are wiring `browser-ext-mcp` into an MCP-capable model, the model should:

- read before acting
- prefer stable refs over brittle selector guesses
- use `wait_for` for delayed UI instead of retrying clicks blindly
- ask for confirmation before destructive or high-risk actions
- use screenshots as evidence, not as the default first step
- keep work inside the agent session instead of the user's unrelated tabs

For installation and client wiring:

- [llm-install.md](./llm-install.md)

For the full capability matrix:

- [features.md](./features.md)
