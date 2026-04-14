import { DEFAULT_RELAY_PORT, RELAY_PORT_SCAN_LIMIT, inspectRelayPort } from "./relay.js";
import { runBridgeServer, startRelayForBridge } from "./app.js";

const DEFAULT_PORT = Number(process.env.BROWSER_EXT_RELAY_PORT ?? String(DEFAULT_RELAY_PORT));

function printUsage() {
  console.log("Usage: browser-ext-bridge <status|start>");
}

async function run() {
  const command = process.argv[2] ?? "status";

  if (command === "status") {
    for (let port = DEFAULT_PORT; port < DEFAULT_PORT + RELAY_PORT_SCAN_LIMIT; port += 1) {
      const status = await inspectRelayPort(port);

      if (status.status === "self") {
        console.log(
          JSON.stringify(
            {
              status: "running",
              port: status.health.port,
              version: status.health.version,
              pending: status.health.pending,
              inflight: status.health.inflight,
              lastPollAt: status.health.lastPollAt
            },
            null,
            2
          )
        );
        return;
      }
    }

    console.log(
      JSON.stringify(
        {
          status: "stopped",
          startPort: DEFAULT_PORT,
          endPort: DEFAULT_PORT + RELAY_PORT_SCAN_LIMIT - 1
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  if (command === "start") {
    const result = await startRelayForBridge(DEFAULT_PORT);

    if (result.status === "already_running") {
      console.error(`browser-ext-mcp relay already running on port ${result.port}; reuse the existing bridge.`);
      return;
    }

    if (result.status === "no_available_port") {
      console.error(
        `browser-ext-mcp relay could not find a free port in range ${result.startPort}-${result.endPort}.`
      );
      process.exit(1);
    }

    console.error(`browser-ext-mcp relay started on port ${result.port}.`);

    const shutdown = async () => {
      await result.relayServer.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });

    const keepAlive = setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
    clearInterval(keepAlive);
    return;
  }

  printUsage();
  process.exit(1);
}

await run();
