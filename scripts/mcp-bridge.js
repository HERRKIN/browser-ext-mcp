#!/usr/bin/env node

const { createBridgeMcpClient } = require("./lib/bridge-mcp-client");
const { createRelayLiveClient } = require("./lib/relay-live-client");

function printUsage() {
  console.error("Usage:");
  console.error("  node scripts/mcp-bridge.js tools [--port <relayPort>]");
  console.error("  node scripts/mcp-bridge.js call <toolName> [jsonArgs] [--port <relayPort>]");
}

function parseArgs(argv) {
  const args = [...argv];
  let relayPort;

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--port") {
      continue;
    }

    relayPort = Number(args[index + 1]);
    args.splice(index, 2);
    index -= 1;
  }

  return {
    args,
    relayPort
  };
}

async function main() {
  const { args, relayPort } = parseArgs(process.argv.slice(2));
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  if (command === "tools") {
    const client = await createBridgeMcpClient({ relayPort });
    try {
      const result = await client.listTools();
      console.log(JSON.stringify(result.tools, null, 2));
      return;
    } finally {
      await client.close();
    }
  }

  let client = await createRelayLiveClient({ relayPort });
  if (!client) {
    client = await createBridgeMcpClient({ relayPort });
  }

  try {
    if (command === "call") {
      const toolName = args[1];
      if (!toolName) {
        printUsage();
        process.exit(1);
      }

      const toolArgs = args[2] ? JSON.parse(args[2]) : {};
      const result = await client.callTool(toolName, toolArgs);
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    printUsage();
    process.exit(1);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
