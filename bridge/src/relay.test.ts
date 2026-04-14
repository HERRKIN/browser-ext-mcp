import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  inspectRelayPort,
  RELAY_HEALTH_SERVICE,
  RELAY_HEALTH_VERSION,
  RelayAlreadyRunningError,
  RelayPortInUseError,
  RelayServer
} from "./relay.js";

const EXTENSION_ORIGIN = "chrome-extension://test-extension-id";

async function pairRole(relay: RelayServer, role: "bridge" | "extension") {
  const headers = role === "extension" ? { origin: EXTENSION_ORIGIN } : undefined;
  const response = await fetch(`${relay.url}/pair?role=${role}`, headers ? { headers } : undefined);
  return response;
}

function extensionHeaders(token: string, extraHeaders: Record<string, string> = {}) {
  return {
    origin: EXTENSION_ORIGIN,
    authorization: `Bearer ${token}`,
    ...extraHeaders
  };
}

async function readNextSseEvent(
  response: Response,
  { signal }: { signal?: AbortSignal } = {}
): Promise<{ event: string; data: string }> {
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abortPromise =
    signal ?
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(signal.reason ?? new Error("Aborted"));
          },
          { once: true }
        );
      })
    : null;

  while (true) {
    const readPromise = reader.read();
    const chunk = abortPromise ? await Promise.race([readPromise, abortPromise]) : await readPromise;

    if (chunk.done) {
      throw new Error("SSE stream ended before an event was received.");
    }

    buffer += decoder.decode(chunk.value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      separatorIndex = buffer.indexOf("\n\n");

      const lines = rawEvent
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0 && !line.startsWith(":"));

      if (lines.length === 0) {
        continue;
      }

      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");

      return { event, data };
    }
  }
}

test("relay serves health, pull, and result flow", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const healthResponse = await fetch(`${relay.url}/health`);
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()) as {
      ok: boolean;
      service: string;
      version: string;
      port: number;
      pending: number;
      inflight: number;
      paired: boolean;
      tokenExpiresAt: string | null;
    };
    assert.equal(health.ok, true);
    assert.equal(health.service, RELAY_HEALTH_SERVICE);
    assert.equal(health.version, RELAY_HEALTH_VERSION);
    assert.ok(typeof health.port === "number");
    assert.equal(health.pending, 0);
    assert.equal(health.inflight, 0);
    assert.equal(health.paired, false);
    assert.equal(health.tokenExpiresAt, null);

    const unauthorizedPullResponse = await fetch(`${relay.url}/pull`);
    assert.equal(unauthorizedPullResponse.status, 401);

    const pairResponse = await pairRole(relay, "extension");
    assert.equal(pairResponse.status, 200);
    const pairing = (await pairResponse.json()) as {
      ok: boolean;
      role: string;
      token: string;
      expiresAt: string;
    };
    assert.equal(pairing.ok, true);
    assert.equal(pairing.role, "extension");
    assert.ok(typeof pairing.token === "string" && pairing.token.length > 0);
    assert.ok(typeof pairing.expiresAt === "string");

    const pendingResult = relay.enqueue("tabs_list", {});

    const pullResponse = await fetch(`${relay.url}/pull`, {
      headers: {
        ...extensionHeaders(pairing.token)
      }
    });
    assert.equal(pullResponse.status, 200);
    const command = (await pullResponse.json()) as {
      requestId: string;
      tool: string;
    };
    assert.equal(command.tool, "tabs_list");

    const resultResponse = await fetch(`${relay.url}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extensionHeaders(pairing.token)
      },
      body: JSON.stringify({
        requestId: command.requestId,
        ok: true,
        message: "Tabs listed.",
        data: [{ id: 1, title: "Example" }]
      })
    });

    assert.equal(resultResponse.status, 200);

    const secondPairResponse = await pairRole(relay, "extension");
    assert.equal(secondPairResponse.status, 409);

    const pairedHealthResponse = await fetch(`${relay.url}/health`);
    assert.equal(pairedHealthResponse.status, 200);
    const pairedHealth = (await pairedHealthResponse.json()) as {
      paired: boolean;
    };
    assert.equal(pairedHealth.paired, true);

    const result = await pendingResult;
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, [{ id: 1, title: "Example" }]);
  } finally {
    await relay.stop();
  }
});

test("relay accepts direct command calls over the paired local endpoint", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const bridgePairResponse = await pairRole(relay, "bridge");
    assert.equal(bridgePairResponse.status, 200);
    const bridgePairing = (await bridgePairResponse.json()) as {
      token: string;
    };
    const extensionPairResponse = await pairRole(relay, "extension");
    assert.equal(extensionPairResponse.status, 200);
    const extensionPairing = (await extensionPairResponse.json()) as {
      token: string;
    };

    const commandPromise = fetch(`${relay.url}/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bridgePairing.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        tool: "tabs_list",
        input: {}
      })
    });

    let pullResponse: Response | null = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(`${relay.url}/pull`, {
        headers: {
          ...extensionHeaders(extensionPairing.token)
        }
      });

      if (response.status === 200) {
        pullResponse = response;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(pullResponse);
    assert.equal(pullResponse.status, 200);
    const command = (await pullResponse.json()) as {
      requestId: string;
      tool: string;
    };
    assert.equal(command.tool, "tabs_list");

    const resultResponse = await fetch(`${relay.url}/result`, {
      method: "POST",
      headers: {
        ...extensionHeaders(extensionPairing.token),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: command.requestId,
        ok: true,
        message: "Tabs listed.",
        data: [{ id: 7, title: "Books" }]
      })
    });
    assert.equal(resultResponse.status, 200);

    const commandResponse = await commandPromise;
    assert.equal(commandResponse.status, 200);
    const commandResult = (await commandResponse.json()) as {
      ok: boolean;
      data: unknown;
    };
    assert.equal(commandResult.ok, true);
    assert.deepEqual(commandResult.data, [{ id: 7, title: "Books" }]);
  } finally {
    await relay.stop();
  }
});

test("relay extracts job control metadata from queued tool input", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const pairResponse = await pairRole(relay, "extension");
    assert.equal(pairResponse.status, 200);
    const pairing = (await pairResponse.json()) as {
      token: string;
    };

    const pendingResult = relay.enqueue("read_page", {
      mode: "interactive",
      jobId: "job-overlay-sequence",
      jobStart: true,
      jobEnd: false
    });

    const pullResponse = await fetch(`${relay.url}/pull`, {
      headers: {
        ...extensionHeaders(pairing.token)
      }
    });
    assert.equal(pullResponse.status, 200);

    const command = (await pullResponse.json()) as {
      requestId: string;
      tool: string;
      input: { mode?: string; jobId?: string; jobStart?: boolean; jobEnd?: boolean };
      jobId?: string;
      jobStart?: boolean;
      jobEnd?: boolean;
    };

    assert.equal(command.tool, "read_page");
    assert.deepEqual(command.input, { mode: "interactive" });
    assert.equal(command.jobId, "job-overlay-sequence");
    assert.equal(command.jobStart, true);
    assert.equal(command.jobEnd, undefined);

    const resultResponse = await fetch(`${relay.url}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...extensionHeaders(pairing.token)
      },
      body: JSON.stringify({
        requestId: command.requestId,
        ok: true,
        message: "Page read.",
        data: { title: "Fixture" }
      })
    });
    assert.equal(resultResponse.status, 200);

    const result = await pendingResult;
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { title: "Fixture" });
  } finally {
    await relay.stop();
  }
});

test("relay emits an SSE notification as soon as a command is queued", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const extensionPairResponse = await pairRole(relay, "extension");
    assert.equal(extensionPairResponse.status, 200);
    const pairing = (await extensionPairResponse.json()) as {
      token: string;
    };

    const abortController = new AbortController();
    const eventsResponse = await fetch(`${relay.url}/events`, {
      headers: extensionHeaders(pairing.token),
      signal: abortController.signal
    });
    assert.equal(eventsResponse.status, 200);

    const nextEventPromise = readNextSseEvent(eventsResponse, {
      signal: abortController.signal
    });

    const pendingResult = relay.enqueue("tabs_list", {});
    const nextEvent = await nextEventPromise;

    assert.equal(nextEvent.event, "command");
    assert.deepEqual(JSON.parse(nextEvent.data), { pending: 1 });

    const pullResponse = await fetch(`${relay.url}/pull`, {
      headers: {
        ...extensionHeaders(pairing.token)
      }
    });
    assert.equal(pullResponse.status, 200);
    const command = (await pullResponse.json()) as {
      requestId: string;
    };

    const resultResponse = await fetch(`${relay.url}/result`, {
      method: "POST",
      headers: {
        ...extensionHeaders(pairing.token),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        requestId: command.requestId,
        ok: true,
        message: "Tabs listed.",
        data: []
      })
    });
    assert.equal(resultResponse.status, 200);
    await pendingResult;

    abortController.abort();
  } finally {
    await relay.stop();
  }
});

test("relay keeps bridge and extension credentials scoped to their own endpoints", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const bridgePairResponse = await pairRole(relay, "bridge");
    assert.equal(bridgePairResponse.status, 200);
    const bridgePairing = (await bridgePairResponse.json()) as {
      token: string;
    };

    const extensionPairResponse = await pairRole(relay, "extension");
    assert.equal(extensionPairResponse.status, 200);
    const extensionPairing = (await extensionPairResponse.json()) as {
      token: string;
    };

    const pullWithBridgeToken = await fetch(`${relay.url}/pull`, {
      headers: extensionHeaders(bridgePairing.token)
    });
    assert.equal(pullWithBridgeToken.status, 401);

    const commandWithExtensionToken = await fetch(`${relay.url}/command`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${extensionPairing.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        tool: "tabs_list",
        input: {}
      })
    });
    assert.equal(commandWithExtensionToken.status, 401);
  } finally {
    await relay.stop();
  }
});

test("relay start rejects cleanly when another relay instance already owns the port", async () => {
  const firstRelay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await firstRelay.start();

  const firstPort = Number(new URL(firstRelay.url).port);
  const secondRelay = new RelayServer({ port: firstPort, timeoutMs: 1_000 });

  try {
    await assert.rejects(secondRelay.start(), (error: unknown) => {
      assert.ok(error instanceof RelayAlreadyRunningError);
      assert.equal(error.port, firstPort);
      return true;
    });
  } finally {
    await firstRelay.stop();
  }
});

test("inspectRelayPort reports a running relay instance", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const port = Number(new URL(relay.url).port);
    const status = await inspectRelayPort(port);

    assert.equal(status.status, "self");
    assert.equal(status.health.port, port);
    assert.equal(status.health.service, RELAY_HEALTH_SERVICE);
  } finally {
    await relay.stop();
  }
});

test("relay start distinguishes a foreign process on the same port", async () => {
  const foreignServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "not-browser-ext-mcp" }));
  });

  await new Promise<void>((resolve) => {
    foreignServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = foreignServer.address();
  assert.ok(address && typeof address !== "string");

  const relay = new RelayServer({ port: address.port, timeoutMs: 1_000 });

  try {
    const status = await inspectRelayPort(address.port);
    assert.equal(status.status, "foreign");
    assert.equal(status.health, null);

    await assert.rejects(relay.start(), (error: unknown) => {
      assert.ok(error instanceof RelayPortInUseError);
      assert.equal(error.port, address.port);
      return true;
    });
  } finally {
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

test("inspectRelayPort reports an unused port as unreachable", async () => {
  const unusedServer = createServer();
  await new Promise<void>((resolve) => {
    unusedServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = unusedServer.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    unusedServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const status = await inspectRelayPort(port);
  assert.equal(status.status, "unreachable");
  assert.equal(status.health, null);
});

test("relay times out when the extension does not poll", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 30 });
  await relay.start();

  try {
    await assert.rejects(relay.enqueue("read_page", { mode: "interactive" }), /Timed out waiting/);
  } finally {
    await relay.stop();
  }
});

test("relay rejects requests from unexpected origins", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000 });
  await relay.start();

  try {
    const response = await fetch(`${relay.url}/pair?role=bridge`, {
      headers: {
        origin: "https://evil.example"
      }
    });

    assert.equal(response.status, 403);
  } finally {
    await relay.stop();
  }
});

test("relay expires inactive pairings and rotates the token", async () => {
  const relay = new RelayServer({ port: 0, timeoutMs: 1_000, pairingInactivityMs: 20 });
  await relay.start();

  try {
    const firstPairResponse = await pairRole(relay, "extension");
    assert.equal(firstPairResponse.status, 200);
    const firstPairing = (await firstPairResponse.json()) as {
      token: string;
    };

    await new Promise((resolve) => setTimeout(resolve, 35));

    const stalePullResponse = await fetch(`${relay.url}/pull`, {
      headers: {
        ...extensionHeaders(firstPairing.token)
      }
    });
    assert.equal(stalePullResponse.status, 401);

    const healthResponse = await fetch(`${relay.url}/health`);
    assert.equal(healthResponse.status, 200);
    const health = (await healthResponse.json()) as {
      paired: boolean;
    };
    assert.equal(health.paired, false);

    const secondPairResponse = await pairRole(relay, "extension");
    assert.equal(secondPairResponse.status, 200);
    const secondPairing = (await secondPairResponse.json()) as {
      token: string;
    };

    assert.notEqual(secondPairing.token, firstPairing.token);
  } finally {
    await relay.stop();
  }
});
