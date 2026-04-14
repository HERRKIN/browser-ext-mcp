# Publishing Checklist

This repo already has enough substance to make sense as an open source product, but it still helps to separate `usable now` from `release-ready`.

## Release Posture

For this repo, there are really two different thresholds:

- `public repo release`: the codebase is understandable, tested, and honest about its limits
- `hardened product release`: permissions, approvals, and local security are tighter and less trust-based

The current goal should be the first threshold, not the second one. That keeps the release honest and avoids fake certainty around security work that is still open.

## What Is Already Strong Enough To Show Publicly

- local MCP bridge over `stdio`
- local relay with pairing and autodiscovery
- MV3 extension with side panel
- workspace/tab-group isolation for agent tabs
- structured page reading, accessibility, interaction, and screenshots
- real observability: console, network, errors, performance, DOM/CSS inspection
- responsive analysis by breakpoint
- semantic hints in `listTools`
- bridge tests and end-to-end coverage for the main flow

## What The Public README Should State Clearly

- this project connects MCP agents to real Chrome
- it does not depend on a separate browser as the primary workflow
- it requires the extension to be loaded in Chrome
- the bridge can be used by terminal clients such as `codex`, `claude`, `gemini`, and `opencode`
- the security model is local-first: pairing, workspace scope, site policies, and approvals

## What Is Still Missing As A Product

Blocking or near-blocking items for a more formal public release:

- choose a license
- settle on the final release narrative and naming
- document multi-client MCP installation
- document the threat model and troubleshooting more thoroughly
- define how the extension is distributed

Important but not blocking for a first public release:

- deeper iframe reading
- finer approvals and policy controls
- richer persistent artifacts
- `optional_host_permissions`
- shared types between bridge and extension
- stable structured logs and error conventions

## Hardening Gaps To Describe Explicitly

These should be documented clearly in the public release, even if they are not all fixed yet:

- the extension still uses broad page access because the current architecture depends on a global content script and site-wide execution helpers
- `optional_host_permissions` is still future hardening work, not a current guarantee
- site policies and approvals are real, but still basic
- the project is designed to reduce accidental or casual local misuse, not to defend a compromised machine
- Chrome Web Store polish and permission minimization are not done yet

## Recommended Publishing Order

### Phase 1. Documentation Order

- make `README.md` the landing page
- link `features`, `roadmap`, `security`, and `llm-install`
- add screenshots or GIFs for the side panel and workspaces
- state clearly what is already usable and what is still pending

### Phase 2. Operational Order

- verify `npm install`
- verify `npm run build --workspace bridge`
- verify `npm run test --workspace bridge`
- verify `npm run test:e2e`
- verify `npm run mcp:install -- --dry-run`

### Phase 3. Distribution Order

- define the license
- decide whether the bridge is also published to npm or only distributed via the repo
- document versioning for both the bridge and the extension
- prepare an initial changelog and first public tag

## Minimum Release Gate

Before publishing the repo publicly, the baseline should be:

- `README.md` aligned with the real product state
- `docs/index.md`, `docs/security.md`, and `docs/publishing.md` linked from the README
- `npm test`, `npm run typecheck`, and `npm run test:e2e` green
- no committed local artifacts or personal notes
- open hardening items described as follow-up work, not implied guarantees

## Recommended Product Message

`browser-ext-mcp` is an MCP bridge for controlling real Chrome from terminal-based AI agents without relying on a parallel browser, while keeping the agent isolated inside workspace-scoped tab groups.

That message should remain consistent across:

- `README.md`
- package description
- release notes
- screenshots and demos
