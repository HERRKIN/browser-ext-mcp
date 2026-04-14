# Changelog

All notable changes to `browser-ext-mcp` will be documented in this file.

The format is based on Keep a Changelog, adapted to the current pre-release stage of the project.

## Unreleased

### Added
- Real-browser MCP bridge plus MV3 extension workflow for Chrome.
- Workspace-scoped tabs and tab-group isolation for agent activity.
- Structured reading, interaction, screenshots, DOM/CSS inspection, logs, network capture, and responsive analysis.
- Side-panel approvals, site policies, and local relay pairing.

### Changed
- Stabilized relay switching and event-stream coordination across the extension and the e2e suite.
- Improved the in-page activity overlay so screenshots can suspend it and restore it cleanly.
- Expanded release docs around features, publishing, installation, and security posture.

### Notes
- The project is usable now, but still in a pre-release phase.
- Permission minimization and stricter hardening remain tracked follow-up work rather than current guarantees.
