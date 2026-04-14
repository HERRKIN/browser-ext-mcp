#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const bridgeEntry = path.join(repoRoot, "bridge", "dist", "server.js");

function printUsage() {
  console.log(`Usage:
  node scripts/install-mcp-clients.js [options]

Options:
  --clients=<list>       Comma-separated subset of codex,claude,gemini,opencode
  --name=<serverName>    MCP server name (default: browser-ext-mcp)
  --relay-port=<port>    Set BROWSER_EXT_RELAY_PORT for registered clients
  --skip-build           Skip building bridge/dist/server.js
  --dry-run              Print actions without modifying client configs
  --no-force             Do not overwrite existing entries with the same name
  -h, --help             Show this help
`);
}

function parseArgs(argv) {
  const options = {
    clients: ["codex", "claude", "gemini", "opencode"],
    dryRun: false,
    force: true,
    help: false,
    name: "browser-ext-mcp",
    relayPort: null,
    skipBuild: false
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "--no-force") {
      options.force = false;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("--clients=")) {
      options.clients = arg
        .slice("--clients=".length)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    if (arg.startsWith("--name=")) {
      options.name = arg.slice("--name=".length).trim() || options.name;
      continue;
    }

    if (arg.startsWith("--relay-port=")) {
      const value = Number(arg.slice("--relay-port=".length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid relay port: ${arg}`);
      }
      options.relayPort = value;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function commandExists(command) {
  const result = spawnSync("which", [command], {
    encoding: "utf8"
  });
  return result.status === 0;
}

function runCommand(command, args, { allowFailure = false, cwd = repoRoot } = {}) {
  const rendered = [command, ...args].join(" ");
  console.log(`> ${rendered}`);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });

  if (result.status !== 0 && !allowFailure) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(stderr || `Command failed: ${rendered}`);
  }

  return result;
}

function printCommand(command, args) {
  console.log(`> ${[command, ...args].join(" ")}`);
}

function probeCommand(command, args, { cwd = repoRoot } = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8"
  });
}

function ensureBuilt(options) {
  if (options.skipBuild) {
    if (!fs.existsSync(bridgeEntry)) {
      throw new Error("bridge/dist/server.js does not exist and --skip-build was used.");
    }
    return;
  }

  if (options.dryRun) {
    console.log("> npm run build --workspace bridge");
    return;
  }

  runCommand("npm", ["run", "build", "--workspace", "bridge"]);
}

function buildEnvEntries(options) {
  if (!options.relayPort) {
    return [];
  }

  return [`BROWSER_EXT_RELAY_PORT=${String(options.relayPort)}`];
}

function hasOpencodeConfig() {
  return fs.existsSync(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
}

function geminiConfigPath() {
  return path.join(os.homedir(), ".gemini", "settings.json");
}

function codexHasServer(name) {
  if (!commandExists("codex")) {
    return false;
  }

  return probeCommand("codex", ["mcp", "get", name]).status === 0;
}

function claudeHasServer(name) {
  if (!commandExists("claude")) {
    return false;
  }

  return probeCommand("claude", ["mcp", "get", name]).status === 0;
}

function geminiHasServer(name) {
  const configPath = geminiConfigPath();
  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return Boolean(config?.mcpServers?.[name]);
  } catch {
    return false;
  }
}

function installCodex(options) {
  if (!commandExists("codex")) {
    return { client: "codex", status: "skipped", detail: "command not found" };
  }

  const envEntries = buildEnvEntries(options);
  const exists = codexHasServer(options.name);

  if (!options.force && exists) {
    return { client: "codex", status: "skipped", detail: "entry already exists" };
  }

  if (options.dryRun) {
    if (options.force && exists) {
      printCommand("codex", ["mcp", "remove", options.name]);
    }
  } else if (options.force && exists) {
    runCommand("codex", ["mcp", "remove", options.name], { allowFailure: true });
  }

  const args = ["mcp", "add", options.name];
  for (const envEntry of envEntries) {
    args.push("--env", envEntry);
  }
  args.push("--", process.execPath, bridgeEntry);

  if (options.dryRun) {
    printCommand("codex", args);
    return { client: "codex", status: "dry-run", detail: "command printed" };
  }

  runCommand("codex", args);
  return { client: "codex", status: "installed", detail: "registered via codex mcp add" };
}

function installClaude(options) {
  if (!commandExists("claude")) {
    return { client: "claude", status: "skipped", detail: "command not found" };
  }

  const envEntries = buildEnvEntries(options);
  const exists = claudeHasServer(options.name);

  if (!options.force && exists) {
    return { client: "claude", status: "skipped", detail: "entry already exists" };
  }

  if (options.dryRun) {
    if (options.force && exists) {
      printCommand("claude", ["mcp", "remove", "-s", "user", options.name]);
    }
  } else if (options.force && exists) {
    runCommand("claude", ["mcp", "remove", "-s", "user", options.name], { allowFailure: true });
  }

  const args = ["mcp", "add", "-s", "user"];
  for (const envEntry of envEntries) {
    args.push("-e", envEntry);
  }
  args.push(options.name, "--", process.execPath, bridgeEntry);

  if (options.dryRun) {
    printCommand("claude", args);
    return { client: "claude", status: "dry-run", detail: "command printed" };
  }

  runCommand("claude", args);
  return { client: "claude", status: "installed", detail: "registered via claude mcp add" };
}

function installGemini(options) {
  if (!commandExists("gemini")) {
    return { client: "gemini", status: "skipped", detail: "command not found" };
  }

  const envEntries = buildEnvEntries(options);
  const exists = geminiHasServer(options.name);

  if (!options.force && exists) {
    return { client: "gemini", status: "skipped", detail: "entry already exists" };
  }

  if (options.dryRun) {
    if (options.force && exists) {
      printCommand("gemini", ["mcp", "remove", "-s", "user", options.name]);
    }
  } else if (options.force && exists) {
    runCommand("gemini", ["mcp", "remove", "-s", "user", options.name], { allowFailure: true });
  }

  const args = ["mcp", "add", "-s", "user"];
  for (const envEntry of envEntries) {
    args.push("-e", envEntry);
  }
  args.push(options.name, process.execPath, bridgeEntry);

  if (options.dryRun) {
    printCommand("gemini", args);
    return { client: "gemini", status: "dry-run", detail: "command printed" };
  }

  runCommand("gemini", args);
  return { client: "gemini", status: "installed", detail: "registered via gemini mcp add" };
}

function installOpencode(options) {
  if (!commandExists("opencode") && !hasOpencodeConfig()) {
    return { client: "opencode", status: "skipped", detail: "command/config not found" };
  }

  const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  const directory = path.dirname(configPath);
  const environment = {};
  if (options.relayPort) {
    environment.BROWSER_EXT_RELAY_PORT = String(options.relayPort);
  }

  let config = {
    $schema: "https://opencode.ai/config.json",
    mcp: {}
  };

  if (fs.existsSync(configPath)) {
    const current = fs.readFileSync(configPath, "utf8");
    config = JSON.parse(current);
  }

  if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) {
    config.mcp = {};
  }

  if (!options.force && config.mcp[options.name]) {
    return { client: "opencode", status: "skipped", detail: "entry already exists" };
  }

  config.mcp[options.name] = {
    type: "local",
    enabled: true,
    command: [process.execPath, bridgeEntry],
    ...(Object.keys(environment).length > 0 ? { environment } : {})
  };

  if (options.dryRun) {
    console.log(`> write ${configPath}`);
    console.log(JSON.stringify(config, null, 2));
    return { client: "opencode", status: "dry-run", detail: "config printed" };
  }

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { client: "opencode", status: "installed", detail: `updated ${configPath}` };
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const supported = {
    codex: installCodex,
    claude: installClaude,
    gemini: installGemini,
    opencode: installOpencode
  };

  for (const client of options.clients) {
    if (!supported[client]) {
      throw new Error(`Unsupported client: ${client}`);
    }
  }

  ensureBuilt(options);

  const results = options.clients.map((client) => supported[client](options));

  console.log("");
  console.log("Summary:");
  for (const result of results) {
    console.log(`- ${result.client}: ${result.status} (${result.detail})`);
  }

  console.log("");
  console.log(`Bridge entry: ${bridgeEntry}`);
  console.log(`Node binary: ${process.execPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
