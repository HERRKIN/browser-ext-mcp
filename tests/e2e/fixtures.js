const { test: base, chromium, expect } = require("@playwright/test");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const net = require("node:net");

const { createBridgeMcpClient } = require("../../scripts/lib/bridge-mcp-client");

async function resolveServiceWorker(context) {
  const serviceWorkers = context.serviceWorkers();
  if (serviceWorkers.length > 0) {
    return serviceWorkers[0];
  }

  return context.waitForEvent("serviceworker");
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Could not determine a free relay port."));
          return;
        }

        resolve(address.port);
      });
    });

    server.on("error", reject);
  });
}

exports.test = base.extend({
  relayPort: async ({}, use) => {
    await use(await findFreePort());
  },
  context: async ({}, use) => {
    const extensionPath = path.resolve(__dirname, "../../extension");
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-ext-mcp-e2e-"));

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        "--headless=new",
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    await use(context);
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  },
  serviceWorker: async ({ context }, use) => {
    await use({
      async evaluate(pageFunction, arg) {
        let serviceWorker = await resolveServiceWorker(context);

        try {
          return await serviceWorker.evaluate(pageFunction, arg);
        } catch (error) {
          if (!String(error).includes("Target page, context or browser has been closed")) {
            throw error;
          }

          serviceWorker = await resolveServiceWorker(context);
          return serviceWorker.evaluate(pageFunction, arg);
        }
      },
      async url() {
        const serviceWorker = await resolveServiceWorker(context);
        return serviceWorker.url();
      }
    });
  },
  extensionId: async ({ serviceWorker }, use) => {
    const extensionId = (await serviceWorker.url()).split("/")[2];
    await use(extensionId);
  },
  mcpClient: async ({ relayPort, serviceWorker }, use) => {
    const mcpClient = await createBridgeMcpClient({
      relayPort,
      cwd: path.resolve(__dirname, "../..")
    });

    try {
      await use(mcpClient);
    } finally {
      await mcpClient.close();
    }
  }
});

exports.expect = expect;
