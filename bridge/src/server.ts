import { runBridgeServer } from "./app.js";

const result = await runBridgeServer();

if (result.status === "no_available_port") {
  console.error(
    `browser-ext-mcp relay could not find a free port in range ${result.startPort}-${result.endPort}.`
  );
  process.exit(1);
}
