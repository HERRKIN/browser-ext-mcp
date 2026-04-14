const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

function parseToolPayload(text) {
  if (typeof text !== "string") {
    return text;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractTextContent(result) {
  if (!Array.isArray(result?.content)) {
    return "";
  }

  return result.content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

async function createBridgeMcpClient({
  relayPort,
  cwd = path.resolve(__dirname, "../.."),
  bridgeCommand = process.execPath,
  bridgeArgs = [path.join(cwd, "bridge/dist/server.js")]
} = {}) {
  const client = new Client({
    name: "browser-ext-mcp-client",
    version: "0.1.0"
  });

  const transport = new StdioClientTransport({
    command: bridgeCommand,
    args: bridgeArgs,
    cwd,
    env: relayPort ? { BROWSER_EXT_RELAY_PORT: String(relayPort) } : undefined,
    stderr: "pipe"
  });

  let stderr = "";
  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
  }

  await client.connect(transport);

  return {
    client,
    transport,
    relayPort,
    getStderr() {
      return stderr.trim();
    },
    async listTools() {
      return client.listTools();
    },
    async callTool(name, args = {}) {
      const result = await client.callTool({
        name,
        arguments: args
      });

      const text = extractTextContent(result);
      if (result.isError) {
        throw new Error(text || `Tool ${name} failed.`);
      }

      return {
        raw: result,
        text,
        data: parseToolPayload(text)
      };
    },
    async close() {
      await transport.close();
    }
  };
}

module.exports = {
  createBridgeMcpClient
};
