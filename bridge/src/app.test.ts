import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));

async function getFreePort() {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return address.port;
}

import { RELAY_PORT_SCAN_LIMIT } from "./relay.js";
import { startRelayForBridge } from "./app.js";

test("bridge startup picks the next available port when the default is occupied by a foreign process", async () => {
  const foreignServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "foreign-process" }));
  });

  await new Promise<void>((resolve) => {
    foreignServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = foreignServer.address();
  assert.ok(address && typeof address !== "string");

  const result = await startRelayForBridge(address.port);

  try {
    assert.equal(result.status, "started");
    assert.equal(result.port, address.port + 1);
    assert.ok(result.port < address.port + RELAY_PORT_SCAN_LIMIT);
  } finally {
    if (result.status === "started") {
      await result.relayServer.stop();
    }

    await new Promise<void>((resolve, reject) => {
      foreignServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});

test("listTools exposes semantic hints for tool selection", async () => {
  const relayPort = await getFreePort();
  const client = new Client({
    name: "browser-ext-mcp-test-client",
    version: "0.1.0"
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", serverPath],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      BROWSER_EXT_RELAY_PORT: String(relayPort)
    },
    stderr: "pipe"
  });

  await client.connect(transport);

  try {
    const result = await client.listTools();
    const screenshotViewport = result.tools.find((tool) => tool.name === "screenshot_viewport");
    const readPage = result.tools.find((tool) => tool.name === "read_page");
    const waitFor = result.tools.find((tool) => tool.name === "wait_for");

    assert.ok(screenshotViewport);
    assert.ok(readPage);
    assert.ok(waitFor);

    assert.match(screenshotViewport.description ?? "", /primary tool for quick visual inspection/i);
    assert.match(readPage.description ?? "", /stable refs/i);
    assert.match(waitFor.description ?? "", /asynchronous or delayed UI changes/i);

    const screenshotHints = screenshotViewport._meta?.["browser-ext-mcp/tool-hints"] as ToolHints | undefined;
    const readPageHints = readPage._meta?.["browser-ext-mcp/tool-hints"] as ToolHints | undefined;

    assert.deepEqual(screenshotViewport.annotations?.readOnlyHint, true);
    assert.equal(screenshotHints?.category, "visual");
    assert.deepEqual(screenshotHints?.relatedTools?.alternatives, [
      "screenshot_full_page",
      "screenshot_with_labels",
      "read_page"
    ]);
    assert.equal(readPageHints?.category, "reading");
    assert.deepEqual(readPageHints?.relatedTools?.producesRefsFor?.includes("click"), true);
  } finally {
    await transport.close();
  }
});
interface ToolHints {
  category?: string;
  relatedTools?: {
    alternatives?: string[];
    producesRefsFor?: string[];
  };
}
