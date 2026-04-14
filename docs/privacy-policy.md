# Privacy Policy

`browser-ext-mcp` is a local-first browser control extension and companion.

## What The Project Does

The extension and local companion let an MCP-capable AI client interact with your real Chrome session.

That can include:

- reading page structure and interactive elements
- capturing screenshots
- inspecting DOM and CSS
- collecting console logs, page errors, network activity, and performance metrics
- filling forms and interacting with page controls

## How Data Is Processed

The project is designed to work locally on the user's machine.

- the extension talks to a local companion over loopback
- the companion exposes a local MCP server to an AI client
- page data is processed in order to fulfill the browser task requested by the user

The project does not operate a hosted cloud service of its own for browser data.

## What Data May Be Accessed

Depending on the task, the extension and companion may access:

- page URLs and titles
- page text and semantic structure
- form fields and interactive controls
- screenshots of the current page or selected elements
- console logs and browser errors
- network request metadata
- performance metrics

## Storage

The project stores local state needed to operate, such as:

- relay connection metadata
- local pairing state
- workspace/session state
- site policy preferences
- approval state
- artifact metadata and captured analysis results

This storage is local to the browser extension and the local environment where the project is running.

## Sharing

The project itself does not sell browser data and does not provide a hosted sharing backend.

However, if you connect the companion to a third-party AI client or model provider, the data sent through that client is governed by that client's own privacy and data handling policies.

## User Control

You control whether the project is installed, which pages it can operate on, and which browser tasks are executed.

You can also:

- close the agent session
- deny approvals
- change site policies
- remove the extension
- stop using the local companion

## Security Note

`browser-ext-mcp` uses a local-first security model with pairing, session scoping, site policies, and approvals.

It is meant to reduce accidental or casual misuse, not to provide strong protection on a compromised machine.

## Contact

Project repo:

- [github.com/HERRKIN/browser-ext-mcp](https://github.com/HERRKIN/browser-ext-mcp)
