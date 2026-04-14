const { inspectRelayPort } = require("../../bridge/dist/relay.js");
const { getToolStubDefinitions, TOOL_REGISTRY } = require("../../bridge/tool-registry.cjs");

const DEFAULT_RELAY_PORT = 17373;
const RELAY_PORT_SCAN_LIMIT = 10;
const TOOL_NAMES = Object.keys(TOOL_REGISTRY);

async function pairWithRelay(port) {
  const response = await fetch(`http://127.0.0.1:${port}/pair`);
  if (!response.ok) {
    throw new Error(`Relay pair failed with ${response.status}.`);
  }

  const payload = await response.json();
  if (!payload?.ok || typeof payload.token !== "string") {
    throw new Error("Relay pairing did not return a token.");
  }

  return payload.token;
}

async function findRunningRelayPort(startPort = DEFAULT_RELAY_PORT) {
  for (let port = startPort; port < startPort + RELAY_PORT_SCAN_LIMIT; port += 1) {
    const status = await inspectRelayPort(port);
    if (status.status === "self") {
      return port;
    }
  }

  return null;
}

async function callRelayTool(port, token, name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      tool: name,
      input: args
    })
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || `Relay command failed with ${response.status}.`);
  }

  if (payload?.ok === false) {
    throw new Error(payload?.message || `Relay command ${name} failed.`);
  }

  return payload;
}

async function createRelayLiveClient({ relayPort } = {}) {
  const port = relayPort ?? (await findRunningRelayPort());
  if (!port) {
    return null;
  }

  const token = await pairWithRelay(port);

  return {
    port,
    async listTools() {
      return {
        tools: getToolStubDefinitions()
      };
    },
    async callTool(name, args = {}) {
      const data = await callRelayTool(port, token, name, args);
      return {
        raw: data,
        text: JSON.stringify(data.data ?? data, null, 2),
        data: data.data ?? data
      };
    },
    async close() {}
  };
}

module.exports = {
  createRelayLiveClient,
  findRunningRelayPort
};
