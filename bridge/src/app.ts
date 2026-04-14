import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import {
  type BrowserToolName,
  type BrowserToolResult,
  DEFAULT_RELAY_PORT,
  RELAY_PORT_SCAN_LIMIT,
  RelayAlreadyRunningError,
  RelayPortInUseError,
  RelayServer,
  inspectRelayPort
} from "./relay.js";

const require = createRequire(import.meta.url);
const { buildToolMeta, getToolEntry } = require("../tool-registry.cjs") as {
  buildToolMeta: (name: BrowserToolName) => Record<string, unknown>;
  getToolEntry: (name: BrowserToolName) => BrowserToolCatalogEntry;
};

interface BrowserToolCatalogEntry {
  title?: string;
  description: string;
  annotations?: ToolAnnotations;
  hints: Record<string, unknown>;
}

export type BridgeRunResult =
  | { status: "started"; port: number }
  | { status: "already_running"; port: number }
  | { status: "foreign_port_conflict"; port: number }
  | { status: "no_available_port"; startPort: number; endPort: number };

export type RelayStartupResult =
  | { status: "started"; port: number; relayServer: RelayServer }
  | { status: "already_running"; port: number }
  | { status: "no_available_port"; startPort: number; endPort: number };

type RelayCommandTransport = Pick<RelayServer, "enqueue">;
type JobControl = {
  jobId?: string;
  jobStart?: boolean;
  jobEnd?: boolean;
};

const JOB_CONTROL_PARAMS = {
  jobId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional logical job identifier shared across a sequence of tool calls."),
  jobStart: z
    .boolean()
    .optional()
    .describe("Marks this tool call as the start of a browser activity job."),
  jobEnd: z
    .boolean()
    .optional()
    .describe("Marks this tool call as the end of a browser activity job.")
} satisfies z.ZodRawShape;

function textResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };
}

function extractJobControl(args: Record<string, unknown>): JobControl | undefined {
  const jobId = typeof args.jobId === "string" && args.jobId.trim().length > 0 ? args.jobId.trim() : "";
  if (!jobId) {
    return undefined;
  }

  return {
    jobId,
    ...(args.jobStart === true ? { jobStart: true } : {}),
    ...(args.jobEnd === true ? { jobEnd: true } : {})
  };
}

function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match || typeof match[1] !== "string" || typeof match[2] !== "string") {
    return null;
  }

  return {
    mimeType: match[1],
    data: match[2]
  };
}

function imageResultFromRelay(
  result: { ok: boolean; message: string; data?: unknown },
  {
    summary,
    metadata
  }: {
    summary: string;
    metadata?: (payload: Record<string, unknown>) => Record<string, unknown>;
  }
) {
  if (!result.ok) {
    return textResult(result.message);
  }

  if (!result.data || typeof result.data !== "object") {
    return textResult(JSON.stringify(result.data ?? {}, null, 2));
  }

  const payload = result.data as Record<string, unknown>;
  const dataUrl = typeof payload.dataUrl === "string" ? payload.dataUrl : null;
  if (!dataUrl) {
    return textResult(JSON.stringify(payload, null, 2));
  }

  const image = parseDataUrl(dataUrl);
  if (!image) {
    return textResult(JSON.stringify(payload, null, 2));
  }

  const extraMetadata = metadata ? metadata(payload) : {};

  return {
    content: [
      {
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType
      },
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            summary,
            ...extraMetadata
          },
          null,
          2
        )
      }
    ]
  };
}

function inferMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".txt":
      return "text/plain";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".html":
      return "text/html";
    case ".md":
      return "text/markdown";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

async function pairWithRelay(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/pair?role=bridge`);
  if (!response.ok) {
    throw new Error(`Relay pair failed with HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
    ok?: boolean;
    token?: string;
  };

  if (payload.ok !== true || typeof payload.token !== "string") {
    throw new Error("Relay pair did not return a valid token.");
  }

  return payload.token;
}

async function createRemoteRelayClient(port: number): Promise<RelayCommandTransport> {
  let token = await pairWithRelay(port);

  return {
    async enqueue<TInput>(
      tool: BrowserToolName,
      input: TInput,
      jobControl?: { jobId?: string; jobStart?: boolean; jobEnd?: boolean }
    ): Promise<BrowserToolResult> {
      const send = async () =>
        fetch(`http://127.0.0.1:${port}/command`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            tool,
            input,
            ...(jobControl ?? {})
          })
        });

      let response = await send();
      if (response.status === 401) {
        token = await pairWithRelay(port);
        response = await send();
      }

      const payload = (await response.json()) as BrowserToolResult;
      if (!response.ok) {
        return {
          requestId: payload?.requestId ?? "",
          ok: false,
          message: payload?.message || `Relay command failed with HTTP ${response.status}.`
        };
      }

      return payload;
    }
  };
}

async function loadUploadPayload(filePath: string, mimeType?: string) {
  const [contents, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);

  return {
    name: basename(filePath),
    mimeType: mimeType || inferMimeType(filePath),
    size: contents.byteLength,
    lastModified: fileStats.mtimeMs,
    base64: contents.toString("base64")
  };
}

function formatRelayResult(result: { ok: boolean; message: string; data?: unknown }, successText: string) {
  if (
    result.data &&
    typeof result.data === "object" &&
    "approvalRequired" in result.data &&
    result.data.approvalRequired === true
  ) {
    return textResult(JSON.stringify(result.data, null, 2));
  }

  return textResult(result.ok ? successText : result.message);
}

function applyToolCatalogMetadata(registeredTool: RegisteredTool, name: BrowserToolName) {
  const catalogEntry = getToolEntry(name);
  const updates: {
    title?: string;
    description: string;
    annotations?: ToolAnnotations;
    _meta: Record<string, unknown>;
  } = {
    description: catalogEntry.description,
    _meta: buildToolMeta(name)
  };

  if (catalogEntry.title) {
    updates.title = catalogEntry.title;
  }

  if (catalogEntry.annotations) {
    updates.annotations = catalogEntry.annotations;
  }

  registeredTool.update(updates);
}

export async function startRelayForBridge(
  port = Number(process.env.BROWSER_EXT_RELAY_PORT ?? String(DEFAULT_RELAY_PORT))
): Promise<RelayStartupResult> {
  let selectedPort: number | null = null;
  const rangeEnd = port + RELAY_PORT_SCAN_LIMIT - 1;
  let relayServer: RelayServer | null = null;

  for (let candidatePort = port; candidatePort <= rangeEnd; candidatePort += 1) {
    const portStatus = await inspectRelayPort(candidatePort);
    if (portStatus.status === "self") {
      return {
        status: "already_running" as const,
        port: candidatePort
      };
    }

    if (portStatus.status === "foreign") {
      continue;
    }

    relayServer = new RelayServer({ port: candidatePort });

    try {
      await relayServer.start();
      selectedPort = candidatePort;
      break;
    } catch (error) {
      if (error instanceof RelayAlreadyRunningError) {
        return {
          status: "already_running" as const,
          port: error.port
        };
      }

      if (error instanceof RelayPortInUseError) {
        relayServer = null;
        continue;
      }

      throw error;
    }
  }

  if (!relayServer || selectedPort === null) {
    return {
      status: "no_available_port",
      startPort: port,
      endPort: rangeEnd
    };
  }

  return {
    status: "started",
    port: selectedPort,
    relayServer
  };
}

export async function runBridgeServer(port = Number(process.env.BROWSER_EXT_RELAY_PORT ?? String(DEFAULT_RELAY_PORT))) {
  const server = new McpServer({
    name: "browser-ext-mcp",
    version: "0.1.0"
  });

  const relayResult = await startRelayForBridge(port);
  if (relayResult.status === "no_available_port") {
    return relayResult;
  }

  let relayServer: RelayCommandTransport;
  let selectedPort: number;

  if (relayResult.status === "started") {
    relayServer = relayResult.relayServer;
    selectedPort = relayResult.port;
  } else {
    relayServer = await createRemoteRelayClient(relayResult.port);
    selectedPort = relayResult.port;
  }

  const relayJobContext = new AsyncLocalStorage<JobControl | undefined>();
  const baseRelayServer = relayServer;
  relayServer = {
    enqueue<TInput>(tool: BrowserToolName, input: TInput) {
      return baseRelayServer.enqueue(tool, input, relayJobContext.getStore());
    }
  };

  const tool = (name: BrowserToolName, paramsSchema: z.ZodRawShape, cb: (...args: any[]) => unknown) => {
    const wrappedCb = (args: Record<string, unknown>, ...rest: unknown[]) =>
      relayJobContext.run(extractJobControl(args), () => cb(args, ...rest));
    const registeredTool = server.tool(
      name,
      { ...paramsSchema, ...JOB_CONTROL_PARAMS } as never,
      wrappedCb as never
    );
    applyToolCatalogMetadata(registeredTool, name);
    return registeredTool;
  };

  tool("tabs_list", {}, async () => {
    const result = await relayServer.enqueue("tabs_list", {});

    return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
  });

  tool("tab_group_list", {}, async () => {
    const result = await relayServer.enqueue("tab_group_list", {});

    return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
  });

  tool("site_policy_list", {}, async () => {
    const result = await relayServer.enqueue("site_policy_list", {});

    return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
  });

  tool(
    "site_policy_set",
    {
      hostname: z.string().min(1).describe("Hostname to configure, e.g. amazon.com."),
      mode: z.enum(["allow", "ask", "block"]).describe("Policy mode for that hostname.")
    },
    async ({ hostname, mode }) => {
      const result = await relayServer.enqueue("site_policy_set", { hostname, mode });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool("approval_list", {}, async () => {
    const result = await relayServer.enqueue("approval_list", {});

    return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
  });

  tool(
    "approval_decide",
    {
      approvalId: z.string().min(1).describe("Pending approval identifier returned by a guarded action."),
      decision: z.enum(["approve", "deny"]).describe("Whether to approve or deny the pending action.")
    },
    async ({ approvalId, decision }) => {
      const result = await relayServer.enqueue("approval_decide", { approvalId, decision });

      return formatRelayResult(result, `Approval ${decision}d.`);
    }
  );

  tool(
    "artifact_list",
    {
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to all workspaces."),
      type: z.string().min(1).optional().describe("Optional artifact type filter."),
      limit: z.number().int().positive().optional().default(20).describe("Maximum artifacts to return.")
    },
    async ({ workspaceId, type, limit }) => {
      const result = await relayServer.enqueue("artifact_list", { workspaceId, type, limit });
      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "artifact_get",
    {
      artifactId: z.string().min(1).describe("Identifier of the stored artifact to retrieve.")
    },
    async ({ artifactId }) => {
      const result = await relayServer.enqueue("artifact_get", { artifactId });
      if (!result.ok) {
        return textResult(result.message);
      }

      const artifact =
        result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : null;
      const details =
        artifact && artifact.details && typeof artifact.details === "object"
          ? (artifact.details as Record<string, unknown>)
          : null;
      const dataUrl = details && typeof details.dataUrl === "string" ? details.dataUrl : null;

      if (artifact && dataUrl) {
        const image = parseDataUrl(dataUrl);
        if (image) {
          const metadata = { ...artifact };
          if (metadata.details && typeof metadata.details === "object") {
            metadata.details = {
              ...metadata.details,
              dataUrl: "[embedded image content]"
            };
          }

          return {
            content: [
              {
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType
              },
              {
                type: "text" as const,
                text: JSON.stringify(metadata, null, 2)
              }
            ]
          };
        }
      }

      return textResult(JSON.stringify(result.data ?? {}, null, 2));
    }
  );

  tool(
    "artifact_clear",
    {
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; omit to clear all artifacts.")
    },
    async ({ workspaceId }) => {
      const result = await relayServer.enqueue("artifact_clear", { workspaceId });
      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "workspace_create",
    {
      name: z.string().min(1).describe("Human-friendly workspace name."),
      color: z
        .enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"])
        .optional()
        .describe("Chrome tab group color."),
      tabId: z.number().int().optional().describe("Optional seed tab id for the new workspace."),
      targetUrl: z.string().min(1).optional().describe("Optional URL to open as the seed tab for the new workspace.")
    },
    async ({ name, color, tabId, targetUrl }) => {
      const result = await relayServer.enqueue("workspace_create", { name, color, tabId, targetUrl });
      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool("workspace_list", {}, async () => {
    const result = await relayServer.enqueue("workspace_list", {});
    return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
  });

  tool(
    "workspace_activate",
    {
      workspaceId: z.string().min(1).describe("Workspace identifier returned by workspace_list.")
    },
    async ({ workspaceId }) => {
      const result = await relayServer.enqueue("workspace_activate", { workspaceId });
      return textResult(result.ok ? `Activated workspace ${workspaceId}.` : result.message);
    }
  );

  tool(
    "workspace_close",
    {
      workspaceId: z.string().min(1).describe("Workspace identifier to close."),
      closeTabs: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to close the tabs in the workspace group.")
    },
    async ({ workspaceId, closeTabs }) => {
      const result = await relayServer.enqueue("workspace_close", { workspaceId, closeTabs });
      return textResult(result.ok ? `Closed workspace ${workspaceId}.` : result.message);
    }
  );

  tool(
    "tab_attach_to_workspace",
    {
      workspaceId: z.string().min(1).describe("Workspace identifier to attach the tab to."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ workspaceId, tabId }) => {
      const result = await relayServer.enqueue("tab_attach_to_workspace", { workspaceId, tabId });
      return textResult(result.ok ? `Attached tab to workspace ${workspaceId}.` : result.message);
    }
  );

  tool(
    "tab_open",
    {
      url: z.string().min(1).describe("URL to open in a new tab inside the active workspace."),
      active: z.boolean().optional().default(false).describe("Whether the new workspace tab should become active."),
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to the active workspace.")
    },
    async ({ url, active, workspaceId }) => {
      const result = await relayServer.enqueue("tab_open", { url, active, workspaceId });
      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "tab_focus",
    {
      tabId: z.number().int().describe("Tab id to focus within the active workspace."),
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to the active workspace.")
    },
    async ({ tabId, workspaceId }) => {
      const result = await relayServer.enqueue("tab_focus", { tabId, workspaceId });
      return textResult(result.ok ? `Focused tab ${tabId}.` : result.message);
    }
  );

  tool(
    "tab_close",
    {
      tabId: z.number().int().describe("Tab id to close within the active workspace."),
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to the active workspace.")
    },
    async ({ tabId, workspaceId }) => {
      const result = await relayServer.enqueue("tab_close", { tabId, workspaceId });
      return textResult(result.ok ? `Closed tab ${tabId}.` : result.message);
    }
  );

  tool(
    "navigate",
    {
      url: z.string().min(1).describe("URL to open in the active tab."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ url, tabId }) => {
      const result = await relayServer.enqueue("navigate", { url, tabId });

      return formatRelayResult(result, `Navigation requested: ${url}`);
    }
  );

  tool(
    "read_page",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      mode: z
        .enum(["interactive", "all"])
        .optional()
        .default("interactive")
        .describe("Return only interactive elements or a broader page summary.")
    },
    async ({ tabId, mode }) => {
      const result = await relayServer.enqueue("read_page", { tabId, mode });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "get_accessibility_tree",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("get_accessibility_tree", { tabId });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "find_elements",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      role: z
        .string()
        .min(1)
        .optional()
        .describe("Optional exact role filter, e.g. button, input, select, checkbox."),
      labelContains: z
        .string()
        .min(1)
        .optional()
        .describe("Optional case-insensitive substring match over the element label.")
    },
    async ({ tabId, role, labelContains }) => {
      const result = await relayServer.enqueue("find_elements", { tabId, role, labelContains });

      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "wait_for",
    {
      ref: z.string().min(1).optional().describe("Stable element reference produced by read_page."),
      selector: z.string().min(1).optional().describe("Optional CSS selector to wait for."),
      role: z
        .string()
        .min(1)
        .optional()
        .describe("Optional exact role filter, e.g. button, input, select, checkbox."),
      labelContains: z
        .string()
        .min(1)
        .optional()
        .describe("Optional case-insensitive substring match over the element label."),
      textContains: z
        .string()
        .min(1)
        .optional()
        .describe("Optional case-insensitive text snippet to wait for in a visible element."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .default(5000)
        .describe(
          "Maximum wait time in milliseconds. Account for significant delays between tool calls: many real flows have multi-second gaps, so waits shorter than 5000ms are often unnecessary or misleading."
        ),
      pollIntervalMs: z
        .number()
        .int()
        .positive()
        .optional()
        .default(100)
        .describe("Polling interval in milliseconds."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, selector, role, labelContains, textContains, timeoutMs, pollIntervalMs, tabId }) => {
      const result = await relayServer.enqueue("wait_for", {
        ref,
        selector,
        role,
        labelContains,
        textContains,
        timeoutMs,
        pollIntervalMs,
        tabId
      });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "highlight_elements",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      role: z
        .string()
        .min(1)
        .optional()
        .describe("Optional exact role filter, e.g. button, input, select, checkbox."),
      labelContains: z
        .string()
        .min(1)
        .optional()
        .describe("Optional case-insensitive substring match over the element label.")
    },
    async ({ tabId, role, labelContains }) => {
      const result = await relayServer.enqueue("highlight_elements", { tabId, role, labelContains });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "clear_highlights",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("clear_highlights", { tabId });

      return textResult(result.ok ? result.message : result.message);
    }
  );

  tool(
    "inspect_dom_node",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("inspect_dom_node", { ref, tabId });
      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "inspect_css_rules",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("inspect_css_rules", { ref, tabId });
      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "read_all_tabs_in_workspace",
    {
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to the active workspace."),
      mode: z
        .enum(["interactive", "all"])
        .optional()
        .default("interactive")
        .describe("Return only interactive elements or a broader page summary for each tab.")
    },
    async ({ workspaceId, mode }) => {
      const result = await relayServer.enqueue("read_all_tabs_in_workspace", { workspaceId, mode });
      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "collect_data_across_tabs",
    {
      workspaceId: z.string().min(1).optional().describe("Optional workspace identifier; defaults to the active workspace."),
      role: z
        .string()
        .min(1)
        .optional()
        .describe("Optional exact role filter, e.g. button, input, select, checkbox."),
      labelContains: z
        .string()
        .min(1)
        .optional()
        .describe("Optional case-insensitive substring match over the element label.")
    },
    async ({ workspaceId, role, labelContains }) => {
      const result = await relayServer.enqueue("collect_data_across_tabs", { workspaceId, role, labelContains });
      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "click",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("click", { ref, tabId });

      return formatRelayResult(result, `Clicked ${ref}.`);
    }
  );

  tool(
    "type",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      text: z.string().describe("Text to insert into the target input."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, text, tabId }) => {
      const result = await relayServer.enqueue("type", { ref, text, tabId });

      return formatRelayResult(result, `Typed into ${ref}.`);
    }
  );

  tool(
    "clear_input",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("clear_input", { ref, tabId });

      return formatRelayResult(result, `Cleared ${ref}.`);
    }
  );

  tool(
    "select_option",
    {
      ref: z.string().min(1).describe("Stable select reference produced by read_page."),
      value: z.string().optional().describe("Option value to choose."),
      label: z.string().optional().describe("Visible option label to choose."),
      index: z.number().int().nonnegative().optional().describe("Zero-based option index to choose."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, value, label, index, tabId }) => {
      const result = await relayServer.enqueue("select_option", { ref, value, label, index, tabId });

      return formatRelayResult(result, `Selected an option in ${ref}.`);
    }
  );

  tool(
    "toggle_checkbox",
    {
      ref: z.string().min(1).describe("Stable checkbox or radio reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("toggle_checkbox", { ref, tabId });

      return formatRelayResult(result, `Toggled ${ref}.`);
    }
  );

  tool(
    "form_fill",
    {
      fields: z
        .array(
          z.object({
            ref: z.string().min(1).describe("Stable element reference produced by read_page."),
            text: z.string().optional().describe("Text value for text inputs or textareas."),
            clearFirst: z.boolean().optional().describe("Whether to clear the field before applying the value."),
            value: z.string().optional().describe("Option value for select elements."),
            label: z.string().optional().describe("Option label for select elements."),
            checked: z.boolean().optional().describe("Checked state for checkbox or radio inputs.")
          })
        )
        .min(1)
        .describe("Field updates to apply in order."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ fields, tabId }) => {
      const result = await relayServer.enqueue("form_fill", { fields, tabId });

      return formatRelayResult(result, JSON.stringify(result.data ?? {}, null, 2));
    }
  );

  tool(
    "upload_file",
    {
      ref: z.string().min(1).describe("Stable file input reference produced by read_page."),
      filePath: z.string().min(1).describe("Absolute or relative local file path to upload."),
      mimeType: z.string().min(1).optional().describe("Optional MIME type override for the uploaded file."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, filePath, mimeType, tabId }) => {
      const file = await loadUploadPayload(filePath, mimeType);
      const result = await relayServer.enqueue("upload_file", {
        ref,
        file,
        filePath,
        tabId
      });

      return formatRelayResult(result, JSON.stringify(result.data ?? {}, null, 2));
    }
  );

  tool(
    "press_keys",
    {
      keys: z.array(z.string().min(1)).min(1).describe("Keys to dispatch in order, e.g. [\"Tab\", \"Enter\"]."),
      ref: z
        .string()
        .min(1)
        .optional()
        .describe("Optional stable element reference; when omitted, the active element receives the keys."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ keys, ref, tabId }) => {
      const result = await relayServer.enqueue("press_keys", { keys, ref, tabId });

      return formatRelayResult(result, `Pressed ${keys.join(", ")}.`);
    }
  );

  tool(
    "hover",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("hover", { ref, tabId });

      return formatRelayResult(result, `Hovered ${ref}.`);
    }
  );

  tool(
    "scroll",
    {
      x: z.number().optional().default(0).describe("Horizontal scroll delta in pixels."),
      y: z.number().optional().default(0).describe("Vertical scroll delta in pixels."),
      behavior: z
        .enum(["auto", "instant", "smooth"])
        .optional()
        .default("auto")
        .describe("Scroll behavior to request from the page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ x, y, behavior, tabId }) => {
      const result = await relayServer.enqueue("scroll", { x, y, behavior, tabId });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "get_console_logs",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      clear: z.boolean().optional().default(false).describe("Whether to clear the buffered logs after reading them.")
    },
    async ({ tabId, clear }) => {
      const result = await relayServer.enqueue("get_console_logs", { tabId, clear });

      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "start_network_capture",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      clear: z.boolean().optional().default(true).describe("Whether to clear the current request buffer when starting capture.")
    },
    async ({ tabId, clear }) => {
      const result = await relayServer.enqueue("start_network_capture", { tabId, clear });

      return textResult(result.ok ? `Network capture started.` : result.message);
    }
  );

  tool(
    "stop_network_capture",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("stop_network_capture", { tabId });

      return textResult(result.ok ? `Network capture stopped.` : result.message);
    }
  );

  tool(
    "get_last_requests",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      limit: z.number().int().positive().optional().default(20).describe("Maximum number of recent requests to return.")
    },
    async ({ tabId, limit }) => {
      const result = await relayServer.enqueue("get_last_requests", { tabId, limit });

      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "get_last_errors",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      limit: z.number().int().positive().optional().default(20).describe("Maximum number of recent errors to return.")
    },
    async ({ tabId, limit }) => {
      const result = await relayServer.enqueue("get_last_errors", { tabId, limit });

      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "performance_snapshot",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("performance_snapshot", { tabId });

      return textResult(result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.message);
    }
  );

  tool(
    "screenshot_full_page",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("screenshot_full_page", { tabId });
      return imageResultFromRelay(result, {
        summary: "Full-page screenshot captured.",
        metadata: (payload) => ({
          tabId: payload.tabId ?? null
        })
      });
    }
  );

  tool(
    "screenshot_element",
    {
      ref: z.string().min(1).describe("Stable element reference produced by read_page."),
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ ref, tabId }) => {
      const result = await relayServer.enqueue("screenshot_element", { ref, tabId });
      return imageResultFromRelay(result, {
        summary: "Element screenshot captured.",
        metadata: (payload) => ({
          tabId: payload.tabId ?? null,
          ref: payload.ref ?? ref,
          rect: payload.rect ?? null
        })
      });
    }
  );

  tool(
    "screenshot_with_labels",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("screenshot_with_labels", { tabId });
      return imageResultFromRelay(result, {
        summary: "Labeled screenshot captured.",
        metadata: (payload) => ({
          tabId: payload.tabId ?? null,
          labeledCount: payload.labeledCount ?? null
        })
      });
    }
  );

  tool(
    "analyze_responsive_breakpoints",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab."),
      mode: z
        .enum(["interactive", "all"])
        .optional()
        .default("interactive")
        .describe("How rich each breakpoint snapshot should be.")
    },
    async ({ tabId, mode }) => {
      const result = await relayServer.enqueue("analyze_responsive_breakpoints", { tabId, mode });
      return textResult(result.ok ? JSON.stringify(result.data ?? [], null, 2) : result.message);
    }
  );

  tool(
    "screenshot_viewport",
    {
      tabId: z.number().int().optional().describe("Optional tab id; defaults to the active tab.")
    },
    async ({ tabId }) => {
      const result = await relayServer.enqueue("screenshot_viewport", { tabId });
      return imageResultFromRelay(result, {
        summary: "Viewport screenshot captured.",
        metadata: (payload) => ({
          tabId: payload.tabId ?? null
        })
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    status: "started" as const,
    port: selectedPort
  };
}
