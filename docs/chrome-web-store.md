# Chrome Web Store Prep

This document collects what is still needed to ship `browser-ext-mcp` through the Chrome Web Store.

## What Is Already In Place

- MV3 extension with side panel
- public repo and homepage URL in the manifest
- local-first product explanation
- security model documented
- examples and installation docs exist

## What Is Still Needed

### Store Assets

- extension icons for the manifest and listing
- at least one real screenshot of the side panel and browser workflow
- a `440x280` promo image
- ideally one short GIF or short video for the README and listing support material

### Store Listing Copy

Prepare:

- short description
- long description
- category choice
- support URL
- privacy policy URL

## Suggested Product Positioning

Recommended message:

`browser-ext-mcp` connects MCP agents to your real Chrome session through a local companion, with isolated agent tabs, structured page reading, and guarded browser actions.

Important:

- present the extension as a browser control product, not just an installer for another tool
- explain clearly that it requires the local companion from the repo
- explain that agent tabs stay separate from normal browsing

## Permissions Review Notes

These are the permissions most likely to attract review attention:

- `debugger`
- `tabs`
- `tabGroups`
- `scripting`
- `activeTab`
- `<all_urls>`
- loopback access to `127.0.0.1` and `localhost`

The listing should explain why they exist:

- `debugger`: screenshots, console, network, performance, and page diagnostics
- `tabs` and `tabGroups`: isolate and manage agent sessions
- `scripting` and broad host access: read and interact with real pages
- loopback access: communicate with the local companion

## Reviewer Notes To Prepare

The Chrome Web Store reviewer will likely benefit from explicit test instructions.

Suggested structure:

1. Load the extension
2. Install and run the local companion from the repo
3. Open the side panel
4. Confirm that the side panel connects to the local relay
5. Verify a simple workflow such as opening a session and reading a page

## Recommended Next Submission Steps

1. add manifest icons
2. publish the privacy policy page
3. prepare screenshots
4. draft the listing copy
5. prepare reviewer instructions
6. decide whether to submit now with current permissions or wait for tighter permission minimization
