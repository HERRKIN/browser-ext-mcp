import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export const RELAY_HEALTH_SERVICE = "browser-ext-mcp-relay";
export const RELAY_HEALTH_VERSION = "0.1.0";
export const DEFAULT_RELAY_PORT = 17373;
export const RELAY_PORT_SCAN_LIMIT = 10;
const DEFAULT_RELAY_TIMEOUT_MS = 45_000;
const RELAY_PAIRING_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_PAIRING_INACTIVITY_MS = 10 * 60 * 1000;

export type BrowserToolName =
  | "workspace_create"
  | "workspace_list"
  | "workspace_activate"
  | "workspace_close"
  | "tab_attach_to_workspace"
  | "tab_open"
  | "tab_focus"
  | "tab_close"
  | "tabs_list"
  | "tab_group_list"
  | "site_policy_list"
  | "site_policy_set"
  | "approval_list"
  | "approval_decide"
  | "artifact_list"
  | "artifact_get"
  | "artifact_clear"
  | "read_all_tabs_in_workspace"
  | "collect_data_across_tabs"
  | "navigate"
  | "read_page"
  | "get_accessibility_tree"
  | "find_elements"
  | "wait_for"
  | "highlight_elements"
  | "clear_highlights"
  | "inspect_dom_node"
  | "inspect_css_rules"
  | "click"
  | "type"
  | "clear_input"
  | "select_option"
  | "toggle_checkbox"
  | "form_fill"
  | "upload_file"
  | "hover"
  | "press_keys"
  | "scroll"
  | "get_console_logs"
  | "start_network_capture"
  | "stop_network_capture"
  | "get_last_requests"
  | "get_last_errors"
  | "performance_snapshot"
  | "screenshot_full_page"
  | "screenshot_element"
  | "screenshot_with_labels"
  | "analyze_responsive_breakpoints"
  | "screenshot_viewport";

export interface BrowserToolRequest<TInput> {
  requestId: string;
  tool: BrowserToolName;
  input: TInput;
  jobId?: string;
  jobStart?: boolean;
  jobEnd?: boolean;
}

export interface BrowserToolResult {
  requestId: string;
  ok: boolean;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  requestId: string;
  tool: BrowserToolName;
  input: unknown;
  jobId?: string;
  jobStart?: boolean;
  jobEnd?: boolean;
}

interface InflightRequest {
  resolve: (result: BrowserToolResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface BrowserToolJobControl {
  jobId?: string;
  jobStart?: boolean;
  jobEnd?: boolean;
}

interface RelayHealthResponse {
  ok: boolean;
  service: string;
  version: string;
  port: number;
  pending: number;
  inflight: number;
  lastPollAt: string | null;
  paired: boolean;
  tokenExpiresAt: string | null;
}

type PairingRole = "bridge" | "extension";

interface PairingState {
  token: string;
  expiresAt: number;
  pairedAt: number | null;
  lastSeenAt: number | null;
}

interface PairResponse {
  ok: boolean;
  role: PairingRole;
  token: string;
  expiresAt: string;
  reused?: boolean;
}

export interface RelayHealthSnapshot extends RelayHealthResponse {}

export type RelayPortStatus =
  | { status: "self"; health: RelayHealthSnapshot }
  | { status: "foreign" | "unreachable"; health: null };

export class RelayAlreadyRunningError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`browser-ext-mcp relay is already running on port ${port}.`);
    this.name = "RelayAlreadyRunningError";
    this.port = port;
  }
}

export class RelayPortInUseError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`Port ${port} is already in use by another process.`);
    this.name = "RelayPortInUseError";
    this.port = port;
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function normalizeJobControl(candidate: unknown): BrowserToolJobControl | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const jobId = typeof record.jobId === "string" && record.jobId.trim().length > 0 ? record.jobId.trim() : "";
  if (!jobId) {
    return null;
  }

  return {
    jobId,
    ...(record.jobStart === true ? { jobStart: true } : {}),
    ...(record.jobEnd === true ? { jobEnd: true } : {})
  };
}

function splitJobControlFromInput<TInput>(input: TInput): {
  input: TInput;
  job: BrowserToolJobControl | null;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      input,
      job: null
    };
  }

  const record = { ...(input as Record<string, unknown>) };
  const job = normalizeJobControl(record);
  delete record.jobId;
  delete record.jobStart;
  delete record.jobEnd;

  return {
    input: record as TInput,
    job
  };
}

export async function inspectRelayPort(port: number): Promise<RelayPortStatus> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500)
    });

    if (!response.ok) {
      return {
        status: "foreign",
        health: null
      };
    }

    const health = (await response.json()) as Partial<RelayHealthResponse>;
    if (health.service === RELAY_HEALTH_SERVICE) {
      return {
        status: "self",
        health: {
          ok: true,
          service: RELAY_HEALTH_SERVICE,
          version: typeof health.version === "string" ? health.version : RELAY_HEALTH_VERSION,
          port,
          pending: typeof health.pending === "number" ? health.pending : 0,
          inflight: typeof health.inflight === "number" ? health.inflight : 0,
          lastPollAt: typeof health.lastPollAt === "string" ? health.lastPollAt : null,
          paired: health.paired === true,
          tokenExpiresAt: typeof health.tokenExpiresAt === "string" ? health.tokenExpiresAt : null
        }
      };
    }

    return {
      status: "foreign",
      health: null
    };
  } catch {
    return {
      status: "unreachable",
      health: null
    };
  }
}

export class RelayServer {
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly pairingInactivityMs: number;
  private readonly pending: PendingRequest[] = [];
  private readonly inflight = new Map<string, InflightRequest>();
  private readonly eventStreams = new Map<ServerResponse, NodeJS.Timeout>();
  private lastPollAt: string | null = null;
  private server: Server | null = null;
  private readonly pairings: Record<PairingRole, PairingState | null> = {
    bridge: null,
    extension: null
  };

  constructor({ port = 17373, timeoutMs = DEFAULT_RELAY_TIMEOUT_MS, pairingInactivityMs = RELAY_PAIRING_INACTIVITY_MS } = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.pairingInactivityMs = pairingInactivityMs;
  }

  async start() {
    if (this.server) {
      return;
    }

    this.server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (!this.isTrustedLoopbackRequest(url)) {
        writeJson(response, 403, { ok: false, message: "Forbidden" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: RELAY_HEALTH_SERVICE,
          version: RELAY_HEALTH_VERSION,
          port: this.port,
          pending: this.pending.length,
          inflight: this.inflight.size,
          lastPollAt: this.lastPollAt,
          paired: this.hasValidPairing("bridge") || this.hasValidPairing("extension"),
          tokenExpiresAt: this.getLatestPairingExpiry()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/pair") {
        const role = this.getPairingRole(url);
        if (!role) {
          writeJson(response, 400, { ok: false, message: "A pairing role is required." });
          return;
        }

        if (!this.isTrustedRequestForRole(request, role)) {
          writeJson(response, 403, { ok: false, message: "Forbidden" });
          return;
        }

        this.ensureActivePairing(role);
        const pairing = this.pairings[role];

        if (!pairing) {
          writeJson(response, 503, { ok: false, message: "Pairing is unavailable." });
          return;
        }

        if (pairing.pairedAt !== null) {
          if (role === "bridge") {
            pairing.lastSeenAt = Date.now();
            writeJson(response, 200, {
              ok: true,
              role,
              token: pairing.token,
              expiresAt: new Date(pairing.expiresAt).toISOString(),
              reused: true
            } satisfies PairResponse);
            return;
          }

          writeJson(response, 409, { ok: false, message: `The ${role} pairing has already been claimed.` });
          return;
        }

        const pairedAt = Date.now();
        pairing.pairedAt = pairedAt;
        pairing.lastSeenAt = pairedAt;
        writeJson(response, 200, {
          ok: true,
          role,
          token: pairing.token,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
          reused: false
        } satisfies PairResponse);
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        if (!this.isTrustedRequestForRole(request, "extension") || !this.isAuthorized(request, "extension")) {
          writeJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        response.write(": connected\n\n");

        const heartbeat = setInterval(() => {
          try {
            response.write(": keepalive\n\n");
          } catch {
            this.removeEventStream(response);
          }
        }, 15_000);

        this.eventStreams.set(response, heartbeat);

        const cleanup = () => {
          this.removeEventStream(response);
        };

        request.on("close", cleanup);
        response.on("close", cleanup);
        response.on("error", cleanup);

        if (this.pending.length > 0) {
          this.notifyCommandAvailable();
        }

        return;
      }

      if (request.method === "GET" && url.pathname === "/pull") {
        if (!this.isTrustedRequestForRole(request, "extension") || !this.isAuthorized(request, "extension")) {
          writeJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        this.lastPollAt = new Date().toISOString();
        const next = this.pending.shift();

        if (!next) {
          response.writeHead(204).end();
          return;
        }

        writeJson(response, 200, next);
        return;
      }

      if (request.method === "POST" && url.pathname === "/result") {
        if (!this.isTrustedRequestForRole(request, "extension") || !this.isAuthorized(request, "extension")) {
          writeJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        const result = await readJson<BrowserToolResult>(request);
        this.complete(result);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/command") {
        if (!this.isTrustedRequestForRole(request, "bridge") || !this.isAuthorized(request, "bridge")) {
          writeJson(response, 401, { ok: false, message: "Unauthorized" });
          return;
        }

        const command = await readJson<{
          tool?: BrowserToolName;
          input?: unknown;
          jobId?: string;
          jobStart?: boolean;
          jobEnd?: boolean;
        }>(request);
        if (!command || typeof command.tool !== "string") {
          writeJson(response, 400, { ok: false, message: "A tool name is required." });
          return;
        }

        try {
          const result = await this.enqueue(command.tool, command.input ?? {}, {
            ...(typeof command.jobId === "string" && command.jobId.trim().length > 0
              ? { jobId: command.jobId.trim() }
              : {}),
            ...(command.jobStart === true ? { jobStart: true } : {}),
            ...(command.jobEnd === true ? { jobEnd: true } : {})
          });
          writeJson(response, 200, result);
        } catch (error) {
          writeJson(response, 500, {
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      writeJson(response, 404, { ok: false, message: "Not found" });
    });

    await new Promise<void>((resolve, reject) => {
      const handleListening = () => {
        this.server?.off("error", handleError);
        resolve();
      };

      const handleError = (error: NodeJS.ErrnoException) => {
        this.server?.off("listening", handleListening);

        if (error.code !== "EADDRINUSE") {
          this.server = null;
          reject(error);
          return;
        }

        void (async () => {
          this.server = null;
          const portStatus = await inspectRelayPort(this.port);
          if (portStatus.status === "self") {
            reject(new RelayAlreadyRunningError(this.port));
            return;
          }

          reject(new RelayPortInUseError(this.port));
        })();
      };

      this.server?.once("listening", handleListening);
      this.server?.once("error", handleError);
      this.server?.listen(this.port, "127.0.0.1");
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    for (const response of this.eventStreams.keys()) {
      this.removeEventStream(response);
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = null;
    this.pairings.bridge = null;
    this.pairings.extension = null;
  }

  get url() {
    if (!this.server) {
      throw new Error("Relay server has not been started.");
    }

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Relay server does not have a TCP address.");
    }

    return `http://127.0.0.1:${address.port}`;
  }

  private getLatestPairingExpiry() {
    const expirations = Object.values(this.pairings)
      .filter((pairing): pairing is PairingState => pairing !== null)
      .map((pairing) => pairing.expiresAt);

    if (expirations.length === 0) {
      return null;
    }

    return new Date(Math.max(...expirations)).toISOString();
  }

  private isPairingExpired(role: PairingRole) {
    const pairing = this.pairings[role];
    return !pairing || pairing.expiresAt <= Date.now() || this.isPairingInactive(role);
  }

  private isPairingInactive(role: PairingRole) {
    const pairing = this.pairings[role];
    return (
      !pairing ||
      pairing.pairedAt === null ||
      pairing.lastSeenAt === null ||
      Date.now() - pairing.lastSeenAt > this.pairingInactivityMs
    );
  }

  private hasValidPairing(role: PairingRole) {
    const pairing = this.pairings[role];
    return !this.isPairingExpired(role) && pairing?.pairedAt !== null;
  }

  private isAuthorized(request: IncomingMessage, role: PairingRole) {
    const pairing = this.pairings[role];
    if (!this.hasValidPairing(role) || !pairing) {
      return false;
    }

    const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
    const authorized = bearerToken === pairing.token;
    if (authorized) {
      pairing.lastSeenAt = Date.now();
    }

    return authorized;
  }

  private createPairingState(): PairingState {
    return {
      token: randomUUID(),
      expiresAt: Date.now() + RELAY_PAIRING_TTL_MS,
      pairedAt: null,
      lastSeenAt: null
    };
  }

  private ensureActivePairing(role: PairingRole) {
    if (!this.pairings[role] || this.isPairingExpired(role)) {
      this.pairings[role] = this.createPairingState();
    }
  }

  private getPairingRole(url: URL): PairingRole | null {
    const role = url.searchParams.get("role");
    return role === "bridge" || role === "extension" ? role : null;
  }

  private isTrustedLoopbackRequest(url: URL) {
    const hostname = url.hostname.trim().toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(hostname);
  }

  private isTrustedRequestForRole(request: IncomingMessage, role: PairingRole) {
    const origin = request.headers.origin;
    if (!origin || origin === "null") {
      return role === "bridge";
    }

    return role === "extension" && origin.startsWith("chrome-extension://");
  }

  enqueue<TInput>(tool: BrowserToolName, input: TInput, jobControl?: BrowserToolJobControl): Promise<BrowserToolResult> {
    const requestId = randomUUID();
    const extracted = splitJobControlFromInput(input);
    const job = normalizeJobControl(jobControl) ?? extracted.job;

    return new Promise<BrowserToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(requestId);
        reject(
          new Error(
            "Timed out waiting for the extension to execute the command."
          )
        );
      }, this.timeoutMs);

      this.inflight.set(requestId, { resolve, reject, timer });
      this.pending.push({
        requestId,
        tool,
        input: extracted.input,
        ...(job ?? {})
      });
      this.notifyCommandAvailable();
    });
  }

  private complete(result: BrowserToolResult) {
    const inflight = this.inflight.get(result.requestId);
    if (!inflight) {
      return;
    }

    clearTimeout(inflight.timer);
    this.inflight.delete(result.requestId);
    inflight.resolve(result);
  }

  private notifyCommandAvailable() {
    if (this.eventStreams.size === 0) {
      return;
    }

    const payload = `event: command\ndata: ${JSON.stringify({ pending: this.pending.length })}\n\n`;

    for (const response of this.eventStreams.keys()) {
      if (response.destroyed || response.writableEnded) {
        this.removeEventStream(response);
        continue;
      }

      try {
        response.write(payload);
      } catch {
        this.removeEventStream(response);
      }
    }
  }

  private removeEventStream(response: ServerResponse) {
    const heartbeat = this.eventStreams.get(response);
    if (heartbeat) {
      clearInterval(heartbeat);
    }

    this.eventStreams.delete(response);

    if (!response.destroyed && !response.writableEnded) {
      try {
        response.end();
      } catch {}
    }
  }
}
