const http = require("node:http");
const assert = require("node:assert/strict");
const path = require("node:path");

const { test, expect } = require("./fixtures");

let fixtureServer;
let fixtureOrigin;

async function callToolWithPump(mcpClient, pumpPage, name, args) {
  let settled = false;
  let lastPumpResponse = null;
  let executedCount = 0;
  let pumpErrors = 0;

  const toolPromise = mcpClient.callTool(name, args).finally(() => {
    settled = true;
  });

  while (!settled) {
    lastPumpResponse = await pumpPage.evaluate(async () => {
      return chrome.runtime.sendMessage({ type: "poll-relay-once" }).catch((error) => ({
        ok: false,
        error: String(error)
      }));
    });

    if (lastPumpResponse?.result?.executed) {
      executedCount += 1;
    } else {
      const drainResponse = await pumpPage.evaluate(async () => {
        return chrome.runtime.sendMessage({ type: "relay-stream-command-available" }).catch((error) => ({
          ok: false,
          error: String(error)
        }));
      });

      if (drainResponse?.ok && Number(drainResponse?.result?.executed) > 0) {
        executedCount += 1;
        lastPumpResponse = {
          ok: true,
          result: {
            polled: true,
            executed: true,
            drainFallback: true
          }
        };
      } else if (drainResponse?.ok === false) {
        pumpErrors += 1;
      }
    }

    if (lastPumpResponse?.ok === false) {
      pumpErrors += 1;
    }

    if (!settled) {
      await pumpPage.waitForTimeout(75);
    }
  }

  try {
    return await toolPromise;
  } catch (error) {
    const relaySnapshot = await pumpPage.evaluate(async () => {
      const config = await chrome.runtime.sendMessage({ type: "get-relay-config" }).catch(() => null);
      const storage = await chrome.storage.local.get(["relayPort", "relayHealthy", "relayCheckedAt"]);
      let health = null;

      if (config?.result?.port) {
        health = await fetch(`http://127.0.0.1:${config.result.port}/health`)
          .then((response) => (response.ok ? response.json() : { ok: false, status: response.status }))
          .catch((fetchError) => ({ ok: false, error: String(fetchError) }));
      }

      return {
        config: config?.result ?? null,
        storage,
        health
      };
    });

    const pumpSummary = JSON.stringify({
      lastPumpResponse,
      executedCount,
      pumpErrors,
      relaySnapshot
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} | last pump response: ${pumpSummary}`
    );
  }
}

async function disableRelayStream(pumpPage) {
  await pumpPage.evaluate(async () => {
    await chrome.offscreen.closeDocument().catch(() => {});
    await chrome.runtime.sendMessage({ type: "relay-stream-status", connected: false }).catch(() => {});
  });
}

async function connectPanelToRelay(pumpPage, relayPort) {
  await expect
    .poll(
      async () => {
        const setResponse = await pumpPage.evaluate(async (port) => {
          return chrome.runtime
            .sendMessage({
              type: "set-relay-port",
              port
            })
            .catch(() => null);
        }, relayPort);

        if (!setResponse?.ok || setResponse?.result?.port !== relayPort) {
          return null;
        }

        return pumpPage.evaluate(async () => {
          const response = await chrome.runtime.sendMessage({ type: "get-relay-config" }).catch(() => null);
          return response?.ok ? response.result?.port ?? null : null;
        });
      },
      {
        timeout: 10_000,
        message: `Timed out waiting for the extension to switch to relay port ${relayPort}.`
      }
    )
    .toBe(relayPort);
}

function createFixtureServer() {
  return http.createServer((request, response) => {
    if (request.url === "/form") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Fixture Form</title>
            <style>
              body { font-family: sans-serif; min-height: 2200px; }
              nav { margin-bottom: 16px; }
              main.fixture-shell { display: grid; gap: 16px; max-width: 420px; }
              label { display: grid; gap: 6px; }
              .cta-button {
                background: rgb(24, 119, 242);
                color: white;
                border: 0;
                border-radius: 999px;
                padding: 12px 18px;
                box-shadow: 0 10px 24px rgba(24, 119, 242, 0.35);
              }
            </style>
          </head>
          <body>
            <nav aria-label="Primary navigation">
              <a href="/docs">Docs</a>
            </nav>
            <main class="fixture-shell">
              <h1>Fixture Form</h1>
              <section aria-label="Contact details">
                <h2>Contact details</h2>
              <label>
                Full name
                <input type="text" placeholder="Full name" />
              </label>
              <label>
                Plan
                <select aria-label="Plan">
                  <option value="">Choose a plan</option>
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                </select>
              </label>
              <label>
                Notes
                <textarea placeholder="Notes"></textarea>
              </label>
              <label>
                <input type="checkbox" aria-label="Subscribe" />
                Subscribe
              </label>
              <label>
                Key target
                <input type="text" placeholder="Key target" />
              </label>
              </section>
              <section aria-label="Actions">
                <h2>Actions</h2>
              <output id="key-log"></output>
              <output id="hover-log"></output>
              <button id="console-trigger" class="cta-button" type="button">Submit</button>
              </section>
            </main>
            <div style="margin-top: 1600px;">Bottom of page</div>
            <script>
              const keyTarget = document.querySelector('input[placeholder="Key target"]');
              const keyLog = document.getElementById('key-log');
              const hoverLog = document.getElementById('hover-log');
              const consoleTrigger = document.getElementById('console-trigger');
              keyTarget.addEventListener('keydown', (event) => {
                keyLog.textContent = keyLog.textContent ? keyLog.textContent + ',' + event.key : event.key;
              });
              consoleTrigger.addEventListener('mouseenter', () => {
                hoverLog.textContent = 'hovered';
              });
              consoleTrigger.addEventListener('click', () => {
                console.log('submit clicked');
                console.error('submit failed');
                fetch('/api/ping').catch(() => {});
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/overflow") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Overflow Fixture</title>
            <style>
              body { margin: 0; font-family: sans-serif; }
              main { padding: 24px; display: grid; gap: 20px; }
              .wide-strip {
                width: 1500px;
                height: 24px;
                background: linear-gradient(90deg, #1877f2, #4db1ff);
              }
              @media (min-width: 1400px) {
                .wide-strip { width: 1200px; }
              }
              .clip-shell { width: 180px; overflow: hidden; border: 1px solid #cbd5e1; }
              .clip-shell .clip-content { width: 320px; white-space: nowrap; }
            </style>
          </head>
          <body>
            <main>
              <h1>Overflow Fixture</h1>
              <div class="wide-strip" aria-label="Wide strip"></div>
              <div class="clip-shell" aria-label="Clipped shell">
                <div class="clip-content">This content is intentionally wider than the clipping container.</div>
              </div>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/frame-child") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Frame Child</title>
          </head>
          <body>
            <main>
              <h1>Embedded Frame</h1>
              <button type="button">Frame CTA</button>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/delayed") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Delayed Fixture</title>
          </head>
          <body>
            <main>
              <h1>Delayed Fixture</h1>
              <div id="status">Waiting…</div>
            </main>
            <script>
              window.setTimeout(() => {
                const button = document.createElement('button');
                button.id = 'late-button';
                button.type = 'button';
                button.textContent = 'Eventually ready';
                button.addEventListener('click', () => {
                  document.getElementById('status').textContent = 'Clicked';
                });
                document.querySelector('main').appendChild(button);
              }, 1200);
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/upload") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Upload Fixture</title>
          </head>
          <body>
            <main>
              <h1>Upload Fixture</h1>
              <label>
                Upload document
                <input type="file" aria-label="Upload document" />
              </label>
              <output id="upload-result"></output>
            </main>
            <script>
              const input = document.querySelector('input[type="file"]');
              const result = document.getElementById('upload-result');
              input.addEventListener('change', async () => {
                const file = input.files?.[0];
                if (!file) {
                  result.textContent = 'No file selected';
                  return;
                }

                const text = await file.text();
                result.textContent = file.name + '|' + text.trim();
              });
            </script>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/guards") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Interaction Guards</title>
          </head>
          <body>
            <main>
              <h1>Interaction Guards</h1>
              <label>
                Locked field
                <input type="text" aria-label="Locked field" value="fixed" readonly />
              </label>
              <button type="button" disabled>Disabled action</button>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/frames") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Frames Fixture</title>
          </head>
          <body>
            <main>
              <h1>Frames Fixture</h1>
              <iframe title="Embedded child" src="/frame-child"></iframe>
            </main>
          </body>
        </html>`);
      return;
    }

    if (request.url === "/api/ping") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><head><title>Fixture Home</title></head><body><h1>Fixture Home</h1></body></html>");
  });
}

test.beforeAll(async () => {
  fixtureServer = createFixtureServer();
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== "string");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise((resolve, reject) =>
    fixtureServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    })
  );
});

test.beforeEach(async ({ serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.remove(["sitePolicies", "pendingApprovals", "workspaceArtifacts"]);
  });
});

test("loads the extension side panel page", async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole("heading", { name: "Browser Ext MCP" })).toBeVisible();
  await expect(page.getByText("Browser Control")).toBeVisible();
  await expect(page.getByText("This extension needs the local MCP companion.")).toBeVisible();
  await expect(page.locator("#repo-link")).toHaveAttribute("href", "https://github.com/HERRKIN/browser-ext-mcp");
});

test("updates the hero activity light for offline and connected states", async ({ context, extensionId, mcpClient }) => {
  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await expect(sidePanelPage.locator("body")).toHaveAttribute("data-relay", "offline");
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Offline");

  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");
  await expect(sidePanelPage.locator("body")).toHaveAttribute("data-relay", "connected");
  await expect(sidePanelPage.locator("body")).toHaveAttribute("data-activity", "idle");
});

test("creates a dedicated workspace tab without hijacking the user's page", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const appPage = await context.newPage();
  const fixtureUrl = `${fixtureOrigin}/form`;
  await appPage.goto(fixtureUrl);
  await appPage.bringToFront();

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(fixtureUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "QA Workspace",
    targetUrl: fixtureUrl
  });
  expect(createWorkspaceResult.data.name).toBe("QA Workspace");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("QA Workspace · 1 tabs");
  await expect(sidePanelPage.locator("#workspace-list")).toContainText("Fixture Form");
  await expect(sidePanelPage.locator("#workspace-list")).toContainText(fixtureUrl);
  await expect(appPage).toHaveURL(fixtureUrl);

  const tabs = await serviceWorker.evaluate(async () => {
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    return currentTabs.map((tab) => ({
      url: tab.url,
      groupId: tab.groupId,
      active: tab.active
    }));
  });

  const userTabs = tabs.filter((tab) => tab.url === fixtureUrl && tab.groupId === -1);
  const workspaceTabs = tabs.filter((tab) => tab.url === fixtureUrl && tab.groupId >= 0);

  expect(userTabs).toHaveLength(1);
  expect(workspaceTabs).toHaveLength(1);

  await expect(sidePanelPage.getByRole("button", { name: "Focus" }).first()).toBeEnabled();
  await sidePanelPage.getByRole("button", { name: "Focus" }).first().click();

  const focusedWorkspaceTabs = await serviceWorker.evaluate(async () => {
    const currentTabs = await chrome.tabs.query({ currentWindow: true });
    return currentTabs
      .filter((tab) => tab.groupId >= 0)
      .map((tab) => ({
        url: tab.url,
        active: tab.active
      }));
  });

  expect(focusedWorkspaceTabs.filter((tab) => tab.active)).toHaveLength(1);
  expect(focusedWorkspaceTabs.find((tab) => tab.url === fixtureUrl)?.active).toBe(true);
});

test("processes queued MCP commands from background polling without the side panel open", async ({
  context,
  mcpClient,
  serviceWorker
}) => {
  const fixtureUrl = `${fixtureOrigin}/form`;

  await serviceWorker.evaluate(async (relayPort) => {
    await chrome.offscreen.closeDocument().catch(() => {});
    await chrome.storage.local.set({
      relayPort
    });
    await chrome.storage.local.remove(["relayPairingToken", "relayPairingExpiresAt", "relayPairingPort"]);
  }, mcpClient.relayPort);

  const workspacePagePromise = context.waitForEvent("page");
  const createWorkspacePromise = mcpClient.callTool("workspace_create", {
    name: "Background Poll Workspace",
    targetUrl: fixtureUrl
  });

  await serviceWorker.evaluate(async () => {
    await chrome.alarms.create("relay-poll", { when: Date.now() + 100 });
  });

  const createWorkspaceResult = await createWorkspacePromise;
  expect(createWorkspaceResult.data.name).toBe("Background Poll Workspace");

  const workspacePage = await workspacePagePromise;
  await workspacePage.waitForURL(/\/form/);
});

test("opens, reads, and focuses multiple tabs inside the active workspace", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const firstUrl = `${fixtureOrigin}/form`;
  const secondUrl = fixtureOrigin;

  const appPage = await context.newPage();
  await appPage.goto(firstUrl);
  await appPage.bringToFront();

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(firstUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Multi Tab Workspace",
    targetUrl: firstUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Multi Tab Workspace");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("Multi Tab Workspace · 1 tabs");

  const openResult = await callToolWithPump(mcpClient, sidePanelPage, "tab_open", {
    url: secondUrl,
    active: false
  });
  const secondTabId = openResult.data.tab.id;
  expect(typeof secondTabId).toBe("number");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("Multi Tab Workspace · 2 tabs");

  let readAllResponse;
  await expect
    .poll(async () => {
      readAllResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_all_tabs_in_workspace", {
        mode: "interactive"
      });

      return (readAllResponse?.data?.tabs ?? []).map((tab) => tab.page.title).sort();
    })
    .toEqual(["Fixture Form", "Fixture Home"]);

  expect(readAllResponse.data.tabs).toHaveLength(2);

  const focusResult = await callToolWithPump(mcpClient, sidePanelPage, "tab_focus", {
    tabId: secondTabId
  });
  expect(focusResult.data).toBe(`Focused tab ${secondTabId}.`);

  const closeResult = await callToolWithPump(mcpClient, sidePanelPage, "tab_close", {
    tabId: secondTabId
  });
  expect(closeResult.data).toBe(`Closed tab ${secondTabId}.`);

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("Multi Tab Workspace · 1 tabs");

  const workspaceTabs = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter((tab) => tab.groupId >= 0)
      .map((tab) => ({
        id: tab.id,
        url: tab.url,
        active: tab.active
      }));
  });

  expect(workspaceTabs).toHaveLength(1);
  expect(workspaceTabs[0].id).not.toBe(secondTabId);
  expect(workspaceTabs[0].active).toBe(true);
});

test("lists workspace state, site policies, and navigates inside the active workspace", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;
  const homeUrl = fixtureOrigin;
  const hostname = new URL(formUrl).hostname;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Navigation Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Navigation Workspace");

  const workspaces = await callToolWithPump(mcpClient, sidePanelPage, "workspace_list", {});
  expect(Array.isArray(workspaces.data)).toBe(true);
  expect(workspaces.data).toHaveLength(1);
  expect(workspaces.data[0].name).toBe("Navigation Workspace");
  expect(workspaces.data[0].active).toBe(true);

  const tabs = await callToolWithPump(mcpClient, sidePanelPage, "tabs_list", {});
  expect(Array.isArray(tabs.data)).toBe(true);
  expect(tabs.data).toHaveLength(1);
  expect(tabs.data[0].workspaceId).toBe(workspaces.data[0].id);
  expect(tabs.data[0].url).toContain("/form");

  await callToolWithPump(mcpClient, sidePanelPage, "site_policy_set", {
    hostname,
    mode: "ask"
  });
  const policies = await callToolWithPump(mcpClient, sidePanelPage, "site_policy_list", {});
  expect(Array.isArray(policies.data)).toBe(true);
  expect(policies.data.some((entry) => entry.hostname === hostname && entry.mode === "ask")).toBe(true);

  const navigateResult = await callToolWithPump(mcpClient, sidePanelPage, "navigate", {
    url: homeUrl
  });
  expect(navigateResult.data).toBe(`Navigation requested: ${homeUrl}`);

  const pageState = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  expect(pageState.data.title).toBe("Fixture Home");
  expect(pageState.data.url).toBe(`${homeUrl}/`);
});

test("activates, attaches tabs to, and closes workspaces", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const formUrl = `${fixtureOrigin}/form`;
  const homeUrl = fixtureOrigin;

  const personalPage = await context.newPage();
  await personalPage.goto(homeUrl);
  await personalPage.bringToFront();

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const firstWorkspace = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Primary Workspace",
    targetUrl: formUrl
  });
  const secondWorkspace = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Secondary Workspace",
    targetUrl: homeUrl
  });

  expect(firstWorkspace.data.name).toBe("Primary Workspace");
  expect(secondWorkspace.data.name).toBe("Secondary Workspace");

  const activateResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_activate", {
    workspaceId: firstWorkspace.data.id
  });
  expect(activateResult.data).toBe(`Activated workspace ${firstWorkspace.data.id}.`);

  const personalTabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(url) && tab.groupId === -1);
    return match?.id ?? null;
  }, homeUrl);
  expect(typeof personalTabId).toBe("number");

  const attachResult = await callToolWithPump(mcpClient, sidePanelPage, "tab_attach_to_workspace", {
    workspaceId: firstWorkspace.data.id,
    tabId: personalTabId
  });
  expect(attachResult.data).toBe(`Attached tab to workspace ${firstWorkspace.data.id}.`);

  const tabsAfterAttach = await callToolWithPump(mcpClient, sidePanelPage, "tabs_list", {});
  expect(Array.isArray(tabsAfterAttach.data)).toBe(true);
  expect(tabsAfterAttach.data.some((tab) => tab.id === personalTabId)).toBe(true);

  const closeResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_close", {
    workspaceId: secondWorkspace.data.id,
    closeTabs: false
  });
  expect(closeResult.data).toBe(`Closed workspace ${secondWorkspace.data.id}.`);

  const workspacesAfterClose = await callToolWithPump(mcpClient, sidePanelPage, "workspace_list", {});
  expect(workspacesAfterClose.data).toHaveLength(1);
  expect(workspacesAfterClose.data[0].id).toBe(firstWorkspace.data.id);
});

test("fills forms and drives richer interactions inside the workspace", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const firstUrl = `${fixtureOrigin}/form`;

  const appPage = await context.newPage();
  await appPage.goto(firstUrl);
  await appPage.bringToFront();

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(firstUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Forms Workspace",
    targetUrl: firstUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Forms Workspace");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("Forms Workspace · 1 tabs");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  expect(readResponse.data.title).toBe("Fixture Form");
  expect(readResponse.data.landmarks.some((entry) => entry.role === "navigation")).toBe(true);
  expect(readResponse.data.landmarks.some((entry) => entry.role === "main")).toBe(true);
  expect(readResponse.data.headings.some((entry) => entry.level === 1 && entry.text === "Fixture Form")).toBe(true);
  expect(readResponse.data.headings.some((entry) => entry.level === 2 && entry.text === "Contact details")).toBe(true);

  const expandedReadResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "all"
  });
  expect(Array.isArray(expandedReadResponse.data.domSnapshot)).toBe(true);
  expect(
    expandedReadResponse.data.domSnapshot.some((entry) => entry.tagName === "nav" && entry.label === "Primary navigation")
  ).toBe(true);
  expect(
    expandedReadResponse.data.domSnapshot.some((entry) => entry.tagName === "section" && entry.label === "Contact details")
  ).toBe(true);

  const findElementsResponse = await callToolWithPump(mcpClient, sidePanelPage, "find_elements", {
    labelContains: "Full name"
  });
  expect(Array.isArray(findElementsResponse.data)).toBe(true);
  expect(findElementsResponse.data).toHaveLength(1);
  expect(findElementsResponse.data[0].label).toBe("Full name");
  expect(findElementsResponse.data[0].role).toBe("input");

  const findRef = (label) => {
    const element = readResponse.data.interactiveElements.find((entry) => entry.label === label);
    expect(element).toBeTruthy();
    return element.ref;
  };

  const fullNameRef = findRef("Full name");
  const planRef = findRef("Plan");
  const notesRef = findRef("Notes");
  const subscribeRef = findRef("Subscribe");
  const keyTargetRef = findRef("Key target");

  const fillResponse = await callToolWithPump(mcpClient, sidePanelPage, "form_fill", {
    fields: [
      { ref: fullNameRef, text: "Jose Andrade" },
      { ref: planRef, value: "pro" },
      { ref: notesRef, text: "Testing the browser workspace" },
      { ref: subscribeRef, checked: true }
    ]
  });
  expect(Array.isArray(fillResponse.data)).toBe(true);

  const clearResponse = await callToolWithPump(mcpClient, sidePanelPage, "clear_input", { ref: fullNameRef });
  expect(clearResponse.data).toBe(`Cleared ${fullNameRef}.`);

  const selectResponse = await callToolWithPump(mcpClient, sidePanelPage, "select_option", {
    ref: planRef,
    label: "Starter"
  });
  expect(selectResponse.data).toBe(`Selected an option in ${planRef}.`);

  const keyResponse = await callToolWithPump(mcpClient, sidePanelPage, "press_keys", {
    ref: keyTargetRef,
    keys: ["A", "Enter"]
  });
  expect(keyResponse.data).toBe("Pressed A, Enter.");

  const toggleResponse = await callToolWithPump(mcpClient, sidePanelPage, "toggle_checkbox", {
    ref: subscribeRef
  });
  expect(toggleResponse.data).toBe(`Toggled ${subscribeRef}.`);

  const hoverTarget = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  expect(hoverTarget).toBeTruthy();
  const hoverResponse = await callToolWithPump(mcpClient, sidePanelPage, "hover", {
    ref: hoverTarget.ref
  });
  expect(hoverResponse.data).toBe(`Hovered ${hoverTarget.ref}.`);

  const hoverRead = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "all"
  });
  expect(hoverRead.data.domSnapshot.some((entry) => entry.tagName === "output" && entry.text === "hovered")).toBe(true);

  const scrollResponse = await callToolWithPump(mcpClient, sidePanelPage, "scroll", {
    y: 900,
    behavior: "instant"
  });
  expect(scrollResponse.data.y).toBeGreaterThan(0);

  const secondReadResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });

  const getElementByRef = (ref) =>
    secondReadResponse.data.interactiveElements.find((entry) => entry.ref === ref);

  expect(getElementByRef(fullNameRef)?.value).toBe("");
  expect(getElementByRef(planRef)?.value).toBe("starter");
  expect(getElementByRef(notesRef)?.value).toBe("Testing the browser workspace");
  expect(getElementByRef(subscribeRef)?.checked).toBe(false);
  expect(secondReadResponse.data.scroll.y).toBeGreaterThan(0);
});

test("captures an accessibility tree for the active workspace tab", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "A11y Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("A11y Workspace");

  const tree = await callToolWithPump(mcpClient, sidePanelPage, "get_accessibility_tree", {});
  expect(tree.data.role).toBe("document");

  const flatten = (node, acc = []) => {
    acc.push(node);
    for (const child of node.children ?? []) {
      flatten(child, acc);
    }
    return acc;
  };

  const nodes = flatten(tree.data);
  expect(nodes.some((node) => node.role === "navigation" && node.name === "Primary navigation")).toBe(true);
  expect(nodes.some((node) => node.role === "heading" && node.name === "Fixture Form" && node.level === 1)).toBe(true);
  expect(nodes.some((node) => node.role === "button" && node.name === "Submit")).toBe(true);
});

test("reads same-origin iframe content in page snapshots and accessibility tree", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const framesUrl = `${fixtureOrigin}/frames`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(framesUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Frames Workspace",
    targetUrl: framesUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Frames Workspace");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "all"
  });
  expect(Array.isArray(readResponse.data.frames)).toBe(true);
  expect(readResponse.data.frames).toHaveLength(1);
  expect(readResponse.data.frames[0].sameOrigin).toBe(true);
  expect(readResponse.data.frames[0].documentTitle).toBe("Frame Child");
  expect(readResponse.data.frames[0].url).toContain("/frame-child");

  const tree = await callToolWithPump(mcpClient, sidePanelPage, "get_accessibility_tree", {});
  const flatten = (node, acc = []) => {
    acc.push(node);
    for (const child of node.children ?? []) {
      flatten(child, acc);
    }
    return acc;
  };
  const nodes = flatten(tree.data);
  expect(nodes.some((node) => node.tagName === "iframe" && node.name === "Frame Child")).toBe(true);
});

test("highlights matching elements in the active workspace tab", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Highlight Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Highlight Workspace");

  const highlight = await callToolWithPump(mcpClient, sidePanelPage, "highlight_elements", {
    labelContains: "Submit"
  });
  expect(highlight.data.count).toBeGreaterThan(0);
  expect(highlight.data.elements.some((entry) => entry.label === "Submit")).toBe(true);

  const clear = await callToolWithPump(mcpClient, sidePanelPage, "clear_highlights", {});
  expect(clear.data).toBe("Highlights removed.");
});

test("renders, resets, and auto-hides the in-page activity overlay", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const workspacePagePromise = context.waitForEvent("page");
  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Activity Overlay Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Activity Overlay Workspace");

  const workspacePage = await workspacePagePromise;
  await workspacePage.waitForURL(/\/form/);

  await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((entry) => typeof entry.url === "string" && entry.url.includes("/form"));
    if (!tab?.id) {
      throw new Error("Workspace form tab was not found.");
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "page-command",
      command: {
        type: "show_activity_overlay",
        label: "Codex · demo",
        durationMs: 250
      }
    });
  });

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();
  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toContainText("Codex · demo");

  await serviceWorker.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((entry) => typeof entry.url === "string" && entry.url.includes("/form"));
    if (!tab?.id) {
      throw new Error("Workspace form tab was not found.");
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "page-command",
      command: {
        type: "show_activity_overlay",
        label: "Codex · demo again",
        durationMs: 250
      }
    });
  });

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toContainText("Codex · demo again");
  await workspacePage.waitForTimeout(120);
  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();
  await workspacePage.waitForTimeout(220);
  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toHaveCount(0);
});

test("jobEnd clears the in-page activity overlay as soon as the last tool call finishes", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const workspacePagePromise = context.waitForEvent("page");
  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Job Overlay Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Job Overlay Workspace");

  const workspacePage = await workspacePagePromise;
  await workspacePage.waitForURL(/\/form/);

  let settled = false;

  await disableRelayStream(sidePanelPage);

  const waitPromise = mcpClient
    .callTool("wait_for", {
      textContains: "This string should never appear",
      timeoutMs: 500,
      pollIntervalMs: 50,
      jobId: "job-overlay-e2e",
      jobStart: true,
      jobEnd: true
    })
    .finally(() => {
      settled = true;
    });

  await sidePanelPage.evaluate(async () => {
    void chrome.runtime.sendMessage({ type: "poll-relay-once" }).catch(() => null);
    return true;
  });
  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();

  const waitResult = await waitPromise;
  expect(waitResult.text).toContain("Timed out after 500ms");

  await workspacePage.waitForTimeout(100);
  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toHaveCount(0);
});

test("restores the in-page activity overlay after screenshot capture", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const workspacePagePromise = context.waitForEvent("page");
  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Overlay Screenshot Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Overlay Screenshot Workspace");

  const workspacePage = await workspacePagePromise;
  await workspacePage.waitForURL(/\/form/);

  await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((entry) => typeof entry.url === "string" && entry.url.includes("/form"));
    if (!tab?.id) {
      throw new Error("Workspace form tab was not found.");
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "page-command",
      command: {
        type: "show_activity_overlay",
        label: "Codex · screenshot",
        durationMs: 2_000
      }
    });
  });

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();
  await expect(workspacePage.getByText("Codex · screenshot")).toBeVisible();

  await callToolWithPump(mcpClient, sidePanelPage, "screenshot_full_page", {});

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();
  await expect(workspacePage.getByText("Codex · screenshot")).toBeVisible();
});

test("inspects DOM nodes, CSS rules, and element screenshots through MCP", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Inspect Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Inspect Workspace");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const submitButton = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  expect(submitButton).toBeTruthy();

  const domInspection = await callToolWithPump(mcpClient, sidePanelPage, "inspect_dom_node", {
    ref: submitButton.ref
  });
  expect(domInspection.data.tagName).toBe("button");
  expect(domInspection.data.attributes.id).toBe("console-trigger");
  expect(domInspection.data.path).toContain("button#console-trigger");
  expect(domInspection.data.rect.width).toBeGreaterThan(0);

  const cssInspection = await callToolWithPump(mcpClient, sidePanelPage, "inspect_css_rules", {
    ref: submitButton.ref
  });
  expect(cssInspection.data.computedStyle["background-color"]).toBe("rgb(24, 119, 242)");
  expect(cssInspection.data.computedStyle["border-radius"]).toBe("999px");
  expect(cssInspection.data.matchedRules.some((rule) => rule.selectorText.includes(".cta-button"))).toBe(true);

  const screenshot = await callToolWithPump(mcpClient, sidePanelPage, "screenshot_element", {
    ref: submitButton.ref
  });
  expect(Array.isArray(screenshot.raw.content)).toBe(true);
  expect(screenshot.raw.content[0].type).toBe("image");
  expect(screenshot.raw.content[0].mimeType).toBe("image/png");
  expect(typeof screenshot.raw.content[0].data).toBe("string");
  expect(screenshot.raw.content[0].data.length).toBeGreaterThan(1_000);
  expect(screenshot.data.summary).toBe("Element screenshot captured.");
  expect(screenshot.data.ref).toBe(submitButton.ref);
  expect(screenshot.data.rect.width).toBeGreaterThan(0);
});

test("reconciles stale workspace state after the agent tabs are closed externally", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const firstUrl = `${fixtureOrigin}/form`;

  const appPage = await context.newPage();
  await appPage.goto(firstUrl);
  await appPage.bringToFront();

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(firstUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Cleanup Workspace",
    targetUrl: firstUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Cleanup Workspace");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("Cleanup Workspace · 1 tabs");

  await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const workspaceTabs = tabs.filter((tab) => tab.groupId >= 0 && typeof tab.id === "number");
    await chrome.tabs.remove(workspaceTabs.map((tab) => tab.id));
  });

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#active-workspace")).toHaveText("No active agent session");
  await expect(sidePanelPage.locator("#workspace-list")).toHaveText("No agent tabs yet.");
});

test("collects semantic matches across workspace tabs", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Collect Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Collect Workspace");

  const openResult = await callToolWithPump(mcpClient, sidePanelPage, "tab_open", {
    url: formUrl,
    active: false
  });
  expect(typeof openResult.data.tab.id).toBe("number");

  const collectResult = await callToolWithPump(mcpClient, sidePanelPage, "collect_data_across_tabs", {
    labelContains: "Full name"
  });

  expect(Array.isArray(collectResult.data)).toBe(true);
  expect(collectResult.data).toHaveLength(2);
  expect(collectResult.data.every((entry) => entry.label === "Full name")).toBe(true);
  expect(collectResult.data.every((entry) => entry.role === "input")).toBe(true);
  expect(new Set(collectResult.data.map((entry) => entry.tabId)).size).toBe(2);
});

test("lists workspace tab groups through MCP", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Groups Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Groups Workspace");

  await callToolWithPump(mcpClient, sidePanelPage, "tab_open", {
    url: formUrl,
    active: false
  });

  const groups = await callToolWithPump(mcpClient, sidePanelPage, "tab_group_list", {});
  expect(Array.isArray(groups.data)).toBe(true);
  expect(groups.data).toHaveLength(1);
  expect(groups.data[0].workspaceName).toBe("Groups Workspace");
  expect(groups.data[0].tabCount).toBe(2);
  expect(typeof groups.data[0].groupId).toBe("number");
});

test("keeps clicks free and gates only sensitive actions behind visible approvals", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Approval Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Approval Workspace");

  const policyResult = await callToolWithPump(mcpClient, sidePanelPage, "site_policy_set", {
    hostname: "127.0.0.1",
    mode: "ask"
  });
  expect(policyResult.data.mode).toBe("ask");

  await sidePanelPage.getByRole("button", { name: "Refresh" }).click();
  await expect(sidePanelPage.locator("#site-policy")).toHaveValue("ask");

  await callToolWithPump(mcpClient, sidePanelPage, "get_console_logs", {
    clear: true
  });

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const submitButton = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  const fullNameInput = readResponse.data.interactiveElements.find((entry) => entry.label === "Full name");
  expect(submitButton).toBeTruthy();
  expect(fullNameInput).toBeTruthy();

  const clickResponse = await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: submitButton.ref
  });
  await expect
    .poll(async () => {
      const consoleLogs = await callToolWithPump(mcpClient, sidePanelPage, "get_console_logs", {});
      return consoleLogs.data.some((entry) => entry.text.includes("submit clicked"));
    })
    .toBe(true);

  expect(clickResponse.data.approvalRequired).toBeUndefined();

  const typeResponse = await callToolWithPump(mcpClient, sidePanelPage, "type", {
    ref: fullNameInput.ref,
    text: "Jane Approval"
  });
  expect(typeResponse.data.approvalRequired).toBe(true);
  expect(typeof typeResponse.data.approvalId).toBe("string");

  const approvalModal = sidePanelPage.locator("#approval-modal");
  await expect(approvalModal).toBeVisible();
  await expect(approvalModal).toContainText("Sensitive action pending");
  await expect(approvalModal).toContainText("127.0.0.1");
  await expect(approvalModal).toContainText("type");

  await sidePanelPage.getByRole("button", { name: "Always allow this site" }).click();
  await expect(approvalModal).toBeHidden();
  await expect(sidePanelPage.locator("#site-policy")).toHaveValue("allow");

  const workspacePages = context
    .pages()
    .filter((page) => !page.url().startsWith("chrome-extension://") && page.url().includes("/form"));
  const workspacePage = workspacePages.at(-1);
  expect(workspacePage).toBeTruthy();
  await expect(workspacePage.locator('input[placeholder="Full name"]')).toHaveValue("Jane Approval");
});

test("captures console logs from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Console Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Console Workspace");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const submitButton = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  expect(submitButton).toBeTruthy();

  const firstConsoleRead = await callToolWithPump(mcpClient, sidePanelPage, "get_console_logs", {
    clear: true
  });
  expect(Array.isArray(firstConsoleRead.data)).toBe(true);

  const clickResponse = await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: submitButton.ref
  });
  expect(clickResponse.data).toBe(`Clicked ${submitButton.ref}.`);

  await expect
    .poll(async () => {
      const consoleLogs = await callToolWithPump(mcpClient, sidePanelPage, "get_console_logs", {});
      return consoleLogs.data.some((entry) => entry.text.includes("submit clicked"));
    })
    .toBe(true);
});

test("lists and approves pending actions through the MCP approval tools", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const formUrl = `${fixtureOrigin}/form`;
  const hostname = new URL(formUrl).hostname;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Approval API Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Approval API Workspace");

  await callToolWithPump(mcpClient, sidePanelPage, "site_policy_set", {
    hostname,
    mode: "ask"
  });

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const fullNameInput = readResponse.data.interactiveElements.find((entry) => entry.label === "Full name");
  expect(fullNameInput).toBeTruthy();

  const typeResponse = await callToolWithPump(mcpClient, sidePanelPage, "type", {
    ref: fullNameInput.ref,
    text: "Jane MCP Approval"
  });
  expect(typeResponse.data.approvalRequired).toBe(true);
  expect(typeof typeResponse.data.approvalId).toBe("string");

  const approvals = await callToolWithPump(mcpClient, sidePanelPage, "approval_list", {});
  expect(Array.isArray(approvals.data)).toBe(true);
  expect(approvals.data.some((entry) => entry.id === typeResponse.data.approvalId)).toBe(true);

  const approvalResult = await callToolWithPump(mcpClient, sidePanelPage, "approval_decide", {
    approvalId: typeResponse.data.approvalId,
    decision: "approve"
  });
  expect(approvalResult.data).toBe("Approval approved.");

  const workspacePages = context
    .pages()
    .filter((page) => !page.url().startsWith("chrome-extension://") && page.url().includes("/form"));
  const workspacePage = workspacePages.at(-1);
  expect(workspacePage).toBeTruthy();
  await expect(workspacePage.locator('input[placeholder="Full name"]')).toHaveValue("Jane MCP Approval");
});

test("captures recent page errors from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Errors Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Errors Workspace");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const submitButton = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  expect(submitButton).toBeTruthy();

  await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: submitButton.ref
  });

  await expect
    .poll(async () => {
      const errors = await callToolWithPump(mcpClient, sidePanelPage, "get_last_errors", {
        limit: 10
      });
      return errors.data.some((entry) => entry.text.includes("submit failed"));
    })
    .toBe(true);
});

test("captures network requests from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Network Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Network Workspace");

  const readResponse = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const submitButton = readResponse.data.interactiveElements.find((entry) => entry.label === "Submit");
  expect(submitButton).toBeTruthy();

  const captureStart = await callToolWithPump(mcpClient, sidePanelPage, "start_network_capture", {
    clear: true
  });
  expect(captureStart.data).toBe("Network capture started.");

  const clickResponse = await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: submitButton.ref
  });
  expect(clickResponse.data).toBe(`Clicked ${submitButton.ref}.`);

  await expect
    .poll(async () => {
      const requests = await callToolWithPump(mcpClient, sidePanelPage, "get_last_requests", {
        limit: 10
      });
      return requests.data.some((entry) => entry.url.endsWith("/api/ping") && entry.method === "GET");
    })
    .toBe(true);

  const captureStop = await callToolWithPump(mcpClient, sidePanelPage, "stop_network_capture", {});
  expect(captureStop.data).toBe("Network capture stopped.");
});

test("captures a performance snapshot from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Performance Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Performance Workspace");

  const snapshot = await callToolWithPump(mcpClient, sidePanelPage, "performance_snapshot", {});
  expect(typeof snapshot.data).toBe("object");
  expect(snapshot.data).not.toBeNull();
  expect(
    Object.prototype.hasOwnProperty.call(snapshot.data, "Timestamp") ||
      Object.prototype.hasOwnProperty.call(snapshot.data, "JSHeapUsedSize")
  ).toBe(true);
});

test("captures a full-page screenshot from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Screenshot Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Screenshot Workspace");

  const fullPageCapture = await callToolWithPump(mcpClient, sidePanelPage, "screenshot_full_page", {});
  expect(Array.isArray(fullPageCapture.raw.content)).toBe(true);
  expect(fullPageCapture.raw.content[0].type).toBe("image");
  expect(fullPageCapture.raw.content[0].mimeType).toBe("image/png");
  expect(typeof fullPageCapture.raw.content[0].data).toBe("string");
  expect(fullPageCapture.raw.content[0].data.length).toBeGreaterThan(10_000);
  expect(fullPageCapture.raw.content[1].type).toBe("text");
  expect(fullPageCapture.data.summary).toBe("Full-page screenshot captured.");
});

test("captures a viewport screenshot from the active workspace tab", async ({
  context,
  extensionId,
  mcpClient,
  serviceWorker
}) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const workspacePagePromise = context.waitForEvent("page");
  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Viewport Screenshot Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Viewport Screenshot Workspace");

  const workspacePage = await workspacePagePromise;
  await workspacePage.waitForURL(/\/form/);

  await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const tab = tabs.find((entry) => typeof entry.url === "string" && entry.url.includes("/form"));
    if (!tab?.id) {
      throw new Error("Workspace form tab was not found.");
    }

    await chrome.tabs.sendMessage(tab.id, {
      type: "page-command",
      command: {
        type: "show_activity_overlay",
        label: "Codex · viewport",
        durationMs: 2_000
      }
    });
  });

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();

  const capture = await callToolWithPump(mcpClient, sidePanelPage, "screenshot_viewport", {});
  expect(Array.isArray(capture.raw.content)).toBe(true);
  expect(capture.raw.content[0].type).toBe("image");
  expect(capture.raw.content[0].mimeType).toBe("image/png");
  expect(capture.raw.content[1].type).toBe("text");
  expect(capture.data.summary).toBe("Viewport screenshot captured.");

  await expect(workspacePage.locator("#browser-ext-mcp-activity-overlay")).toBeVisible();
});

test("captures a labeled screenshot from the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Labeled Screenshot Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Labeled Screenshot Workspace");

  const capture = await callToolWithPump(mcpClient, sidePanelPage, "screenshot_with_labels", {});
  expect(Array.isArray(capture.raw.content)).toBe(true);
  expect(capture.raw.content[0].type).toBe("image");
  expect(capture.raw.content[0].mimeType).toBe("image/png");
  expect(typeof capture.raw.content[0].data).toBe("string");
  expect(capture.raw.content[0].data.length).toBeGreaterThan(10_000);
  expect(capture.raw.content[1].type).toBe("text");
  expect(capture.data.summary).toBe("Labeled screenshot captured.");
  expect(capture.data.labeledCount).toBeGreaterThan(0);
});

test("persists workspace artifacts for screenshots and analyses", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Artifacts Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Artifacts Workspace");

  await callToolWithPump(mcpClient, sidePanelPage, "screenshot_full_page", {});
  await callToolWithPump(mcpClient, sidePanelPage, "analyze_responsive_breakpoints", {
    mode: "interactive"
  });
  await callToolWithPump(mcpClient, sidePanelPage, "get_console_logs", {});

  const artifacts = await callToolWithPump(mcpClient, sidePanelPage, "artifact_list", {
    limit: 10
  });
  expect(Array.isArray(artifacts.data)).toBe(true);
  expect(artifacts.data.some((entry) => entry.type === "screenshot_full_page")).toBe(true);
  expect(artifacts.data.some((entry) => entry.type === "responsive_analysis")).toBe(true);
  const responsiveSnapshots = artifacts.data.filter((entry) => entry.type === "responsive_snapshot");
  expect(responsiveSnapshots).toHaveLength(3);
  expect(responsiveSnapshots.every((entry) => typeof entry.details?.dataUrl === "string")).toBe(true);

  const snapshotArtifact = await callToolWithPump(mcpClient, sidePanelPage, "artifact_get", {
    artifactId: responsiveSnapshots[0].id
  });
  expect(Array.isArray(snapshotArtifact.raw.content)).toBe(true);
  expect(snapshotArtifact.raw.content[0].type).toBe("image");
  expect(snapshotArtifact.raw.content[1].type).toBe("text");
  expect(snapshotArtifact.data.id).toBe(responsiveSnapshots[0].id);
  expect(snapshotArtifact.data.details.dataUrl).toBe("[embedded image content]");

  expect(artifacts.data.some((entry) => entry.type === "console_logs")).toBe(true);
  expect(artifacts.data.every((entry) => entry.workspaceName === "Artifacts Workspace")).toBe(true);

  const clearResult = await callToolWithPump(mcpClient, sidePanelPage, "artifact_clear", {});
  expect(clearResult.data.cleared).toBeGreaterThanOrEqual(2);

  const emptyArtifacts = await callToolWithPump(mcpClient, sidePanelPage, "artifact_list", {
    limit: 10
  });
  expect(emptyArtifacts.data).toHaveLength(0);
});

test("analyzes responsive breakpoints on the active workspace tab", async ({ context, extensionId, mcpClient }) => {
  const formUrl = `${fixtureOrigin}/form`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(formUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Responsive Workspace",
    targetUrl: formUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Responsive Workspace");

  const analysis = await callToolWithPump(mcpClient, sidePanelPage, "analyze_responsive_breakpoints", {
    mode: "interactive"
  });

  expect(Array.isArray(analysis.data)).toBe(true);
  expect(analysis.data.map((entry) => entry.profile)).toEqual(["mobile", "tablet", "desktop"]);

  const mobile = analysis.data.find((entry) => entry.profile === "mobile");
  const tablet = analysis.data.find((entry) => entry.profile === "tablet");
  const desktop = analysis.data.find((entry) => entry.profile === "desktop");

  expect(mobile.requestedViewport.width).toBeLessThan(tablet.requestedViewport.width);
  expect(tablet.requestedViewport.width).toBeLessThan(desktop.requestedViewport.width);
  expect(mobile.viewport.width).toBeLessThanOrEqual(desktop.viewport.width);
  expect(desktop.headingCount).toBeGreaterThan(0);
  expect(mobile.interactiveCount).toBeGreaterThan(0);
  expect(typeof mobile.snapshotArtifactId).toBe("string");
});

test("detects overflow and clipping issues during responsive analysis", async ({
  context,
  extensionId,
  mcpClient
}) => {
  const overflowUrl = `${fixtureOrigin}/overflow`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(overflowUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Overflow Workspace",
    targetUrl: overflowUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Overflow Workspace");

  const analysis = await callToolWithPump(mcpClient, sidePanelPage, "analyze_responsive_breakpoints", {
    mode: "interactive"
  });
  const mobile = analysis.data.find((entry) => entry.profile === "mobile");
  const desktop = analysis.data.find((entry) => entry.profile === "desktop");

  expect(mobile.layoutIssues.document.horizontalOverflow).toBe(true);
  expect(mobile.layoutIssues.issues.some((issue) => issue.type === "horizontal-overflow")).toBe(true);
  expect(mobile.layoutIssues.issues.some((issue) => issue.type === "clipped-horizontal-content")).toBe(true);
  expect(desktop.layoutIssues.document.horizontalOverflow).toBe(false);
});

test("waits for delayed page content before interacting", async ({ context, extensionId, mcpClient }) => {
  const delayedUrl = `${fixtureOrigin}/delayed`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(delayedUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Wait Workspace",
    targetUrl: delayedUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Wait Workspace");

  await disableRelayStream(sidePanelPage);

  const waitPromise = mcpClient.callTool("wait_for", {
    selector: "#late-button",
    timeoutMs: 3000,
    pollIntervalMs: 75
  });

  await sidePanelPage.evaluate(async () => chrome.runtime.sendMessage({ type: "poll-relay-once" }));

  let settled = false;
  waitPromise.finally(() => {
    settled = true;
  });

  while (!settled) {
    await sidePanelPage.evaluate(async () => chrome.runtime.sendMessage({ type: "poll-relay-once" }).catch(() => null));
    if (!settled) {
      await sidePanelPage.waitForTimeout(75);
    }
  }

  const waitResult = await waitPromise;

  expect(waitResult.data.matched).toBe(true);
  expect(waitResult.data.element.label).toContain("Eventually ready");
  expect(waitResult.data.waitedMs).toBeGreaterThanOrEqual(300);

  await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: waitResult.data.element.ref
  });

  const clickedState = await callToolWithPump(mcpClient, sidePanelPage, "wait_for", {
    textContains: "Clicked",
    timeoutMs: 1500
  });
  expect(clickedState.data.matched).toBe(true);
});

test("uploads a local file through the active workspace page", async ({ context, extensionId, mcpClient }) => {
  const uploadUrl = `${fixtureOrigin}/upload`;
  const uploadFilePath = path.join(__dirname, "..", "fixtures", "upload-fixture.txt");

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(uploadUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Upload Workspace",
    targetUrl: uploadUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Upload Workspace");

  const pageState = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const fileInput = pageState.data.interactiveElements.find(
    (element) => element.tagName === "input" && element.inputType === "file"
  );

  expect(fileInput?.ref).toBeTruthy();

  const uploadResult = await callToolWithPump(mcpClient, sidePanelPage, "upload_file", {
    ref: fileInput.ref,
    filePath: uploadFilePath
  });

  expect(uploadResult.data.files).toHaveLength(1);
  expect(uploadResult.data.files[0].name).toBe("upload-fixture.txt");

  const waitResult = await callToolWithPump(mcpClient, sidePanelPage, "wait_for", {
    textContains: "upload-fixture.txt|Browser Ext MCP upload fixture",
    timeoutMs: 3000,
    pollIntervalMs: 75
  });

  expect(waitResult.data.matched).toBe(true);
});

test("reports disabled and readonly elements as non-interactable", async ({ context, extensionId, mcpClient }) => {
  const guardedUrl = `${fixtureOrigin}/guards`;

  const sidePanelPage = await context.newPage();
  await sidePanelPage.goto(
    `chrome-extension://${extensionId}/sidepanel.html?targetUrl=${encodeURIComponent(guardedUrl)}`
  );
  await connectPanelToRelay(sidePanelPage, mcpClient.relayPort);
  await expect(sidePanelPage.locator("#relay-status")).toContainText("Connected");

  const createWorkspaceResult = await callToolWithPump(mcpClient, sidePanelPage, "workspace_create", {
    name: "Guards Workspace",
    targetUrl: guardedUrl
  });
  expect(createWorkspaceResult.data.name).toBe("Guards Workspace");

  const pageState = await callToolWithPump(mcpClient, sidePanelPage, "read_page", {
    mode: "interactive"
  });
  const readonlyInput = pageState.data.interactiveElements.find(
    (element) => element.tagName === "input" && element.label === "Locked field"
  );
  const disabledButton = pageState.data.interactiveElements.find(
    (element) => element.tagName === "button" && element.label === "Disabled action"
  );

  expect(readonlyInput?.ref).toBeTruthy();
  expect(disabledButton?.ref).toBeTruthy();

  const typeResult = await callToolWithPump(mcpClient, sidePanelPage, "type", {
    ref: readonlyInput.ref,
    text: "new value"
  });
  expect(typeResult.text).toContain("read-only");

  const clickResult = await callToolWithPump(mcpClient, sidePanelPage, "click", {
    ref: disabledButton.ref
  });
  expect(clickResult.text).toContain("disabled");
});
