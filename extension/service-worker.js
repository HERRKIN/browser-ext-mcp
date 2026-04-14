const RELAY_HEALTH_SERVICE = "browser-ext-mcp-relay";
const DEFAULT_RELAY_PORT = 17373;
const RELAY_PORT_SCAN_LIMIT = 10;
const RELAY_PORT_STORAGE_KEY = "relayPort";
const RELAY_PAIRING_TOKEN_STORAGE_KEY = "relayPairingToken";
const RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY = "relayPairingExpiresAt";
const RELAY_PAIRING_PORT_STORAGE_KEY = "relayPairingPort";
const RELAY_BUSY_STORAGE_KEY = "relayBusy";
const WORKSPACE_STORAGE_KEY = "workspaces";
const ACTIVE_WORKSPACE_STORAGE_KEY = "activeWorkspaceId";
const SITE_POLICIES_STORAGE_KEY = "sitePolicies";
const PENDING_APPROVALS_STORAGE_KEY = "pendingApprovals";
const WORKSPACE_ARTIFACTS_STORAGE_KEY = "workspaceArtifacts";
const DEFAULT_WORKSPACE_COLOR = "blue";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const RELAY_POLL_ALARM = "relay-poll";
const RELAY_POLL_PERIOD_MINUTES = 0.5;
const RELAY_STREAM_DOCUMENT_PATH = "offscreen.html";
const RELAY_STREAM_IDLE_MS = 15_000;
const PANEL_HEARTBEAT_TTL_MS = 20_000;
const MAX_CONSOLE_LOG_ENTRIES = 200;
const MAX_NETWORK_REQUEST_ENTRIES = 200;
const MAX_ERROR_ENTRIES = 100;
const debuggerSessions = new Map();
let configuredRelayPortOverride = null;
const RESPONSIVE_PROFILES = [
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  { name: "tablet", width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
];
const GUARDED_SITE_TOOLS = new Set([
  "type",
  "form_fill",
  "clear_input",
  "upload_file"
]);
const MAX_WORKSPACE_ARTIFACTS = 150;
const ACTIVITY_OVERLAY_TIMEOUT_MS = 10_000;
let relayPollInFlight = false;
let relayStreamConnected = false;
let relayStreamDocumentPromise = null;
let relayStreamIdleTimer = null;
let panelPresenceDeadline = 0;
const activeOverlayJobs = new Map();

void chrome.storage.local.set({
  [RELAY_BUSY_STORAGE_KEY]: false
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (typeof tabId !== "number") {
    return;
  }

  const session = debuggerSessions.get(tabId);
  if (!session) {
    return;
  }

  if (method === "Runtime.consoleAPICalled") {
    const text = (params?.args ?? [])
      .map((arg) => arg?.value ?? arg?.unserializableValue ?? arg?.description ?? arg?.type ?? "")
      .filter(Boolean)
      .join(" ");

    session.logs.push({
      source: "runtime",
      type: params?.type ?? "log",
      level: params?.type ?? "log",
      text,
      timestamp: typeof params?.timestamp === "number" ? params.timestamp : Date.now()
    });

    if (params?.type === "error") {
      session.errors.push({
        source: "runtime",
        level: "error",
        text,
        timestamp: typeof params?.timestamp === "number" ? params.timestamp : Date.now()
      });
    }
  }

  if (method === "Log.entryAdded") {
    const entry = {
      source: "log",
      type: params?.entry?.source ?? "log",
      level: params?.entry?.level ?? "info",
      text: params?.entry?.text ?? "",
      timestamp: typeof params?.entry?.timestamp === "number" ? params.entry.timestamp : Date.now()
    };
    session.logs.push(entry);
    if (entry.level === "error") {
      session.errors.push(entry);
    }
  }

  if (method === "Runtime.exceptionThrown") {
    session.errors.push({
      source: "exception",
      level: "error",
      text: params?.exceptionDetails?.text ?? params?.exceptionDetails?.exception?.description ?? "Runtime exception",
      timestamp: typeof params?.timestamp === "number" ? params.timestamp : Date.now()
    });
  }

  if (session.logs.length > MAX_CONSOLE_LOG_ENTRIES) {
    session.logs.splice(0, session.logs.length - MAX_CONSOLE_LOG_ENTRIES);
  }

  if (session.errors.length > MAX_ERROR_ENTRIES) {
    session.errors.splice(0, session.errors.length - MAX_ERROR_ENTRIES);
  }

  if (method === "Network.requestWillBeSent" && session.networkCapture) {
    const requestEntry = {
      requestId: params?.requestId ?? "",
      url: params?.request?.url ?? "",
      method: params?.request?.method ?? "GET",
      resourceType: params?.type ?? "Other",
      status: null,
      mimeType: null,
      failed: false,
      errorText: null
    };

    session.requestsById.set(requestEntry.requestId, requestEntry);
    session.networkRequests.push(requestEntry);
  }

  if (method === "Network.responseReceived" && session.networkCapture) {
    const requestEntry = session.requestsById.get(params?.requestId ?? "");
    if (requestEntry) {
      requestEntry.status = params?.response?.status ?? null;
      requestEntry.mimeType = params?.response?.mimeType ?? null;
    }
  }

  if (method === "Network.loadingFailed" && session.networkCapture) {
    const requestEntry = session.requestsById.get(params?.requestId ?? "");
    if (requestEntry) {
      requestEntry.failed = true;
      requestEntry.errorText = params?.errorText ?? null;
    }
  }

  if (session.networkRequests.length > MAX_NETWORK_REQUEST_ENTRIES) {
    const trimmed = session.networkRequests.splice(0, session.networkRequests.length - MAX_NETWORK_REQUEST_ENTRIES);
    for (const entry of trimmed) {
      session.requestsById.delete(entry.requestId);
    }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    debuggerSessions.delete(source.tabId);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(RELAY_PORT_STORAGE_KEY in changes)) {
    return;
  }

  const nextPort = Number(changes[RELAY_PORT_STORAGE_KEY]?.newValue);
  configuredRelayPortOverride =
    Number.isInteger(nextPort) && nextPort > 0 && nextPort <= 65535 ? nextPort : null;
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureRelayPort();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create(RELAY_POLL_ALARM, { periodInMinutes: RELAY_POLL_PERIOD_MINUTES });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureRelayPort();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.alarms.create(RELAY_POLL_ALARM, { periodInMinutes: RELAY_POLL_PERIOD_MINUTES });
});

chrome.action.onClicked.addListener(async (tab) => {
  const path = buildControlCenterPath(tab?.url);
  const targetTabId = typeof tab.id === "number" ? tab.id : undefined;
  const targetWindowId = typeof tab.windowId === "number" ? tab.windowId : undefined;

  try {
    await chrome.sidePanel.setOptions({
      tabId: targetTabId,
      path,
      enabled: true
    });

    if (targetWindowId !== undefined) {
      await chrome.sidePanel.open({ windowId: targetWindowId });
      return;
    }

    if (targetTabId !== undefined) {
      await chrome.sidePanel.open({ tabId: targetTabId });
      return;
    }
  } catch {}

  await chrome.tabs.create({
    url: chrome.runtime.getURL(path)
  });
});

function buildControlCenterPath(targetUrl) {
  return targetUrl ? `sidepanel.html?targetUrl=${encodeURIComponent(targetUrl)}` : "sidepanel.html";
}

async function openControlCenterTab(targetUrl) {
  const url = buildControlCenterPath(targetUrl);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(url)
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "open-control-center") {
    openControlCenterTab(message.targetUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "poll-relay-once") {
    pollRelayOnce()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "ensure-relay-stream") {
    ensureRelayEventStreamReady()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "panel-presence") {
    updatePanelPresence(message.active === true)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-relay-stream-config") {
    getRelayStreamConfig()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "relay-stream-command-available") {
    drainRelayQueue()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "relay-stream-status") {
    relayStreamConnected = message.connected === true;
    if (!relayStreamConnected) {
      void scheduleRelayStreamTrim();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "relay-stream-unauthorized") {
    clearRelayPairing()
      .then(() => notifyRelayStreamConfigChanged())
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-active-tab") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      sendResponse({ tab });
    });
    return true;
  }

  if (message?.type === "get-workspace-state") {
    getWorkspaceStateSnapshot()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-relay-config") {
    getRelayConfig()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-site-policy-state") {
    getSitePolicyStateForPanel()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "set-site-policy") {
    setSitePolicy(message.hostname, message.mode)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "get-approvals") {
    listPendingApprovals()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "approval-decide") {
    decideApproval(message.approvalId, message.decision)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "set-relay-port") {
    setRelayPort(message.port)
      .then(async (port) => {
        const healthy = await pingRelay();
        await updateRelayHealth(healthy);
        sendResponse({
          ok: true,
          result: {
            port,
            healthy
          }
        });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-create") {
    createWorkspace({
      name: message.name,
      color: message.color,
      tabId: message.tabId,
      targetUrl: message.targetUrl
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-activate") {
    activateWorkspace(message.workspaceId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-focus") {
    focusWorkspace(message.workspaceId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-close") {
    closeWorkspace(message.workspaceId, Boolean(message.closeTabs))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-open-tab") {
    openTabInWorkspace({
      workspaceId: message.workspaceId,
      url: message.url,
      active: message.active
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-focus-tab") {
    focusWorkspaceTab({
      workspaceId: message.workspaceId,
      tabId: message.tabId
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "workspace-read-all-tabs") {
    readAllTabsInWorkspace({
      workspaceId: message.workspaceId,
      mode: message.mode
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "run-browser-tool") {
    executeCommand({
      tool: message.tool,
      input: message.input ?? {}
    })
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        })
      );
    return true;
  }

  return false;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RELAY_POLL_ALARM) {
    return;
  }

  await drainRelayQueue();
});

function generateWorkspaceId() {
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureRelayPort() {
  if (
    Number.isInteger(configuredRelayPortOverride) &&
    configuredRelayPortOverride > 0 &&
    configuredRelayPortOverride <= 65535
  ) {
    return configuredRelayPortOverride;
  }

  const state = await chrome.storage.local.get([RELAY_PORT_STORAGE_KEY]);
  const port = Number(state[RELAY_PORT_STORAGE_KEY]);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    configuredRelayPortOverride = port;
    return port;
  }

  return DEFAULT_RELAY_PORT;
}

async function getRelayPort() {
  if (
    Number.isInteger(configuredRelayPortOverride) &&
    configuredRelayPortOverride > 0 &&
    configuredRelayPortOverride <= 65535
  ) {
    return configuredRelayPortOverride;
  }

  const state = await chrome.storage.local.get([RELAY_PORT_STORAGE_KEY]);
  const port = Number(state[RELAY_PORT_STORAGE_KEY]);

  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    configuredRelayPortOverride = port;
    return port;
  }

  return ensureRelayPort();
}

async function getRelayUrl() {
  return `http://127.0.0.1:${await getRelayPort()}`;
}

async function getRelayConfig() {
  const state = await chrome.storage.local.get([
    RELAY_PAIRING_TOKEN_STORAGE_KEY,
    RELAY_PAIRING_PORT_STORAGE_KEY
  ]);

  return {
    port: await getRelayPort(),
    defaultPort: DEFAULT_RELAY_PORT,
    paired: typeof state[RELAY_PAIRING_TOKEN_STORAGE_KEY] === "string",
    pairedPort: Number.isInteger(state[RELAY_PAIRING_PORT_STORAGE_KEY])
      ? state[RELAY_PAIRING_PORT_STORAGE_KEY]
      : null
  };
}

async function hasRelayEventStreamDocument() {
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(RELAY_STREAM_DOCUMENT_PATH)]
  });

  return contexts.length > 0;
}

function isPanelPresent() {
  return panelPresenceDeadline > Date.now();
}

function clearRelayStreamIdleTimer() {
  if (relayStreamIdleTimer !== null) {
    clearTimeout(relayStreamIdleTimer);
    relayStreamIdleTimer = null;
  }
}

async function closeRelayEventStreamDocument() {
  clearRelayStreamIdleTimer();

  if (!chrome.offscreen?.closeDocument) {
    return false;
  }

  if (!(await hasRelayEventStreamDocument())) {
    relayStreamConnected = false;
    return false;
  }

  await chrome.offscreen.closeDocument().catch(() => {});
  relayStreamConnected = false;
  return true;
}

async function scheduleRelayStreamTrim() {
  clearRelayStreamIdleTimer();

  if (isPanelPresent() || relayPollInFlight) {
    return false;
  }

  relayStreamIdleTimer = setTimeout(() => {
    void trimRelayStreamIfIdle();
  }, RELAY_STREAM_IDLE_MS);

  return true;
}

async function trimRelayStreamIfIdle() {
  clearRelayStreamIdleTimer();

  if (isPanelPresent() || relayPollInFlight) {
    return false;
  }

  const state = await chrome.storage.local.get([RELAY_BUSY_STORAGE_KEY]);
  if (state[RELAY_BUSY_STORAGE_KEY] === true) {
    return false;
  }

  const closed = await closeRelayEventStreamDocument();
  if (closed) {
    await notifyRelayStreamConfigChanged();
  }

  return closed;
}

async function updatePanelPresence(active) {
  panelPresenceDeadline = active ? Date.now() + PANEL_HEARTBEAT_TTL_MS : 0;

  if (active) {
    clearRelayStreamIdleTimer();
    await ensureRelayEventStreamReady();
  } else {
    await scheduleRelayStreamTrim();
  }

  return {
    active: isPanelPresent()
  };
}

async function ensureRelayEventStreamDocument() {
  if (!chrome.offscreen?.createDocument) {
    return false;
  }

  if (await hasRelayEventStreamDocument()) {
    return true;
  }

  if (relayStreamDocumentPromise) {
    return relayStreamDocumentPromise;
  }

  relayStreamDocumentPromise = chrome.offscreen
    .createDocument({
      url: RELAY_STREAM_DOCUMENT_PATH,
      reasons: ["WORKERS"],
      justification: "Maintain a low-latency relay event stream for local MCP browser commands."
    })
    .then(() => true)
    .finally(() => {
      relayStreamDocumentPromise = null;
    });

  return relayStreamDocumentPromise;
}

async function ensureRelayEventStreamReady() {
  clearRelayStreamIdleTimer();
  await ensureRelayEventStreamDocument();
  await notifyRelayStreamConfigChanged();
  return true;
}

async function notifyRelayStreamConfigChanged() {
  try {
    await chrome.runtime.sendMessage({ type: "relay-stream-config-changed" });
  } catch {}
}

async function getRelayStreamConfig() {
  const relayConnection = await resolveRelayConnection();
  if (!relayConnection) {
    return {
      enabled: false
    };
  }

  const authHeaders = await getRelayAuthHeaders(relayConnection);
  const token = authHeaders.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    return {
      enabled: false
    };
  }

  return {
    enabled: true,
    url: `${relayConnection.url}/events`,
    headers: {
      authorization: `Bearer ${token}`
    },
    port: relayConnection.port
  };
}

async function setRelayPort(port) {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error("Relay port must be an integer between 1 and 65535.");
  }

  configuredRelayPortOverride = parsedPort;

  await chrome.storage.local.set({
    [RELAY_PORT_STORAGE_KEY]: parsedPort
  });

  await clearRelayPairing();
  await ensureRelayEventStreamReady();

  return parsedPort;
}

async function clearRelayPairing() {
  await chrome.storage.local.remove([
    RELAY_PAIRING_TOKEN_STORAGE_KEY,
    RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY,
    RELAY_PAIRING_PORT_STORAGE_KEY
  ]);
}

async function getStoredRelayPairing(port) {
  const state = await chrome.storage.local.get([
    RELAY_PAIRING_TOKEN_STORAGE_KEY,
    RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY,
    RELAY_PAIRING_PORT_STORAGE_KEY
  ]);

  const token = typeof state[RELAY_PAIRING_TOKEN_STORAGE_KEY] === "string" ? state[RELAY_PAIRING_TOKEN_STORAGE_KEY] : null;
  const expiresAt = typeof state[RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY] === "string" ? state[RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY] : null;
  const pairedPort = Number.isInteger(state[RELAY_PAIRING_PORT_STORAGE_KEY]) ? state[RELAY_PAIRING_PORT_STORAGE_KEY] : null;

  if (!token || !expiresAt || pairedPort !== port) {
    return null;
  }

  if (Date.parse(expiresAt) <= Date.now()) {
    await clearRelayPairing();
    return null;
  }

  return {
    token,
    expiresAt
  };
}

async function requestRelayPairing(relayConnection) {
  const response = await fetch(`${relayConnection.url}/pair?role=extension`);
  if (!response.ok) {
    throw new Error(`Relay pairing failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (!payload?.token || !payload?.expiresAt) {
    throw new Error("Relay pairing did not return a valid token.");
  }

  await chrome.storage.local.set({
    [RELAY_PAIRING_TOKEN_STORAGE_KEY]: payload.token,
    [RELAY_PAIRING_EXPIRES_AT_STORAGE_KEY]: payload.expiresAt,
    [RELAY_PAIRING_PORT_STORAGE_KEY]: relayConnection.port
  });

  return {
    token: payload.token,
    expiresAt: payload.expiresAt
  };
}

async function getRelayAuthHeaders(relayConnection, { forceRefresh = false } = {}) {
  const existingPairing = !forceRefresh ? await getStoredRelayPairing(relayConnection.port) : null;
  const pairing = existingPairing ?? (await requestRelayPairing(relayConnection));

  return {
    authorization: `Bearer ${pairing.token}`
  };
}

async function fetchRelayHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return null;
    }

    const health = await response.json();
    return health?.service === RELAY_HEALTH_SERVICE ? health : null;
  } catch {
    return null;
  }
}

async function discoverRelayPort(
  preferredPort,
  { allowFallback = true, persistResolvedPort = true } = {}
) {
  const candidates = [];

  if (Number.isInteger(preferredPort)) {
    candidates.push(preferredPort);
  }

  if (allowFallback) {
    for (let port = DEFAULT_RELAY_PORT; port < DEFAULT_RELAY_PORT + RELAY_PORT_SCAN_LIMIT; port += 1) {
      if (!candidates.includes(port)) {
        candidates.push(port);
      }
    }
  }

  for (const port of candidates) {
    const health = await fetchRelayHealth(port);
    if (!health) {
      continue;
    }

    const previousPort = await getRelayPort().catch(() => null);
    if (persistResolvedPort) {
      await chrome.storage.local.set({
        [RELAY_PORT_STORAGE_KEY]: port
      });
    }

    if (previousPort !== port) {
      await clearRelayPairing();
    }

    return {
      port,
      health
    };
  }

  return null;
}

async function resolveRelayConnection() {
  const configuredPort = await getRelayPort();
  const usesDefaultPort = configuredPort === DEFAULT_RELAY_PORT;
  const discoveredRelay = await discoverRelayPort(configuredPort, {
    allowFallback: usesDefaultPort,
    persistResolvedPort: usesDefaultPort
  });

  if (!discoveredRelay) {
    return null;
  }

  return {
    port: discoveredRelay.port,
    url: `http://127.0.0.1:${discoveredRelay.port}`,
    health: discoveredRelay.health
  };
}

async function pingRelay() {
  const relayConnection = await resolveRelayConnection();
  return relayConnection !== null;
}

async function updateRelayHealth(healthy) {
  await chrome.storage.local.set({
    relayHealthy: healthy,
    relayCheckedAt: new Date().toISOString()
  });
}

async function updateRelayBusy(busy) {
  await chrome.storage.local.set({
    [RELAY_BUSY_STORAGE_KEY]: busy
  });

  if (busy) {
    clearRelayStreamIdleTimer();
    return;
  }

  await scheduleRelayStreamTrim();
}

async function notifyRelayActivity(busy, tool = null) {
  try {
    await chrome.runtime.sendMessage({
      type: "relay-activity",
      busy,
      tool
    });
  } catch {}
}

async function postResult(result) {
  const relayConnection = await resolveRelayConnection();
  if (!relayConnection) {
    throw new Error("Could not find a running browser-ext-mcp relay.");
  }

  let headers = {
    "content-type": "application/json",
    ...(await getRelayAuthHeaders(relayConnection))
  };

  let response = await fetch(`${relayConnection.url}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify(result)
  });

  if (response.status === 401) {
    await clearRelayPairing();
    headers = {
      "content-type": "application/json",
      ...(await getRelayAuthHeaders(relayConnection, { forceRefresh: true }))
    };
    response = await fetch(`${relayConnection.url}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify(result)
    });
  }

  if (!response.ok) {
    throw new Error(`Relay result endpoint returned HTTP ${response.status}`);
  }
}

async function requireActiveWorkspace() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    throw new Error("No active workspace. Create or activate an agent workspace first.");
  }

  return workspace;
}

async function resolveWorkspace(workspaceId) {
  if (typeof workspaceId === "string" && workspaceId.length > 0) {
    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} was not found.`);
    }

    return workspace;
  }

  return requireActiveWorkspace();
}

async function getTargetTab(tabId) {
  const workspace = await requireActiveWorkspace();
  const workspaceTabs = await chrome.tabs.query({ groupId: workspace.groupId });

  if (workspaceTabs.length === 0) {
    throw new Error(`Workspace ${workspace.name} has no tabs.`);
  }

  if (typeof tabId === "number") {
    const matchingTab = workspaceTabs.find((tab) => tab.id === tabId);
    if (!matchingTab?.id) {
      throw new Error(`Tab ${tabId} is not part of the active workspace ${workspace.id}.`);
    }

    return matchingTab;
  }

  const preferredTab = workspaceTabs.find((tab) => tab.active) ?? workspaceTabs[0];
  if (!preferredTab?.id) {
    throw new Error(`Workspace ${workspace.name} does not have a usable tab.`);
  }

  return preferredTab;
}

async function findTabByUrl(targetUrl) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return (
    tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(targetUrl)) ?? null
  );
}

async function sendPageCommand(tabId, command) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: "page-command",
      command
    });
  } catch (error) {
    if (!isMissingPageReceiverError(error)) {
      throw error;
    }

    await ensurePageCommandReceiver(tabId);
    await waitForDelay(50);

    return chrome.tabs.sendMessage(tabId, {
      type: "page-command",
      command
    });
  }
}

function isMissingPageReceiverError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Receiving end does not exist");
}

function canInjectContentScript(url) {
  if (typeof url !== "string" || url.length === 0) {
    return false;
  }

  return /^(https?:|file:)/.test(url);
}

async function ensurePageCommandReceiver(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!canInjectContentScript(tab?.url)) {
    throw new Error(`No content script receiver is available for ${tab?.url ?? "this tab"}.`);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"]
  });
}

async function activateTabForCapture(tabId) {
  const tab = await chrome.tabs.get(tabId);

  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }

  await chrome.tabs.update(tabId, { active: true });
  await waitForDelay(75);
}

async function showActivityOverlayOnTab(tabId, label) {
  try {
    await sendPageCommand(tabId, {
      type: "show_activity_overlay",
      label,
      durationMs: ACTIVITY_OVERLAY_TIMEOUT_MS
    });
  } catch {}
}

async function clearActivityOverlayOnTab(tabId) {
  try {
    await sendPageCommand(tabId, {
      type: "clear_activity_overlay"
    });
  } catch {}
}

async function suspendActivityOverlayOnTab(tabId) {
  try {
    const result = await sendPageCommand(tabId, {
      type: "suspend_activity_overlay"
    });
    return result?.data && typeof result.data === "object" ? result.data : { visible: false };
  } catch {
    return { visible: false };
  }
}

async function restoreActivityOverlayOnTab(tabId, snapshot) {
  if (!snapshot || snapshot.visible !== true) {
    return;
  }

  try {
    await sendPageCommand(tabId, {
      type: "restore_activity_overlay",
      ...snapshot
    });
  } catch {}
}

async function withActivityOverlaySuspended(tabId, callback) {
  const snapshot = await suspendActivityOverlayOnTab(tabId);

  try {
    return await callback();
  } finally {
    await restoreActivityOverlayOnTab(tabId, snapshot);
  }
}

function normalizeActivityJobId(jobId) {
  return typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : "";
}

function scheduleTrackedJobExpiry(jobId) {
  const trackedJob = activeOverlayJobs.get(jobId);
  if (!trackedJob) {
    return;
  }

  if (trackedJob.timeoutId) {
    clearTimeout(trackedJob.timeoutId);
  }

  trackedJob.timeoutId = setTimeout(() => {
    const expiredJob = activeOverlayJobs.get(jobId);
    if (!expiredJob) {
      return;
    }

    activeOverlayJobs.delete(jobId);
    void Promise.all(Array.from(expiredJob.tabIds).map((tabId) => clearActivityOverlayOnTab(tabId)));
  }, ACTIVITY_OVERLAY_TIMEOUT_MS);
}

function mergeTrackedJobTabIds(jobId, tabIds = []) {
  const normalizedJobId = normalizeActivityJobId(jobId);
  if (!normalizedJobId) {
    return Array.from(new Set(tabIds));
  }

  const trackedJob = activeOverlayJobs.get(normalizedJobId) ?? {
    tabIds: new Set(),
    timeoutId: null
  };
  const merged = new Set(trackedJob.tabIds);
  for (const tabId of tabIds) {
    if (typeof tabId === "number") {
      merged.add(tabId);
    }
  }

  trackedJob.tabIds = merged;
  activeOverlayJobs.set(normalizedJobId, trackedJob);
  scheduleTrackedJobExpiry(normalizedJobId);
  return Array.from(merged);
}

function consumeTrackedJobTabIds(jobId, fallbackTabIds = []) {
  const normalizedJobId = normalizeActivityJobId(jobId);
  const merged = new Set(fallbackTabIds);

  if (normalizedJobId) {
    const tracked = activeOverlayJobs.get(normalizedJobId);
    if (tracked) {
      if (tracked.timeoutId) {
        clearTimeout(tracked.timeoutId);
      }
      for (const tabId of tracked.tabIds) {
        merged.add(tabId);
      }
      activeOverlayJobs.delete(normalizedJobId);
    }
  }

  return Array.from(merged);
}

async function getActivityOverlayTabIds(command) {
  if (typeof command.input?.tabId === "number") {
    const tab = await getTargetTab(command.input.tabId).catch(() => null);
    return tab?.id ? [tab.id] : [];
  }

  if (command.tool === "read_all_tabs_in_workspace" || command.tool === "collect_data_across_tabs") {
    const workspace = await resolveWorkspace(command.input?.workspaceId).catch(() => null);
    if (!workspace) {
      return [];
    }

    const workspaceTabs = await chrome.tabs.query({ groupId: workspace.groupId });
    const activeTab = workspaceTabs.find((tab) => tab.active && typeof tab.id === "number") ?? workspaceTabs[0];
    return activeTab?.id ? [activeTab.id] : [];
  }

  const tab = await getTargetTab().catch(() => null);
  return tab?.id ? [tab.id] : [];
}

function waitForDelay(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function normalizeHostname(hostname) {
  return typeof hostname === "string" ? hostname.trim().toLowerCase() : "";
}

function isLocalHostname(hostname) {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHostname(hostname));
}

async function getSitePolicies() {
  const state = await chrome.storage.local.get([SITE_POLICIES_STORAGE_KEY]);
  return state[SITE_POLICIES_STORAGE_KEY] ?? {};
}

async function setSitePolicies(policies) {
  await chrome.storage.local.set({
    [SITE_POLICIES_STORAGE_KEY]: policies
  });
}

async function listSitePolicies() {
  const policies = await getSitePolicies();
  return Object.entries(policies).map(([hostname, entry]) => ({
    hostname,
    mode: entry.mode,
    updatedAt: entry.updatedAt
  }));
}

function getDefaultSitePolicy(hostname) {
  return "allow";
}

async function resolveSitePolicy(hostname) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return {
      hostname: "",
      mode: "allow",
      explicit: false
    };
  }

  const policies = await getSitePolicies();
  const entry = policies[normalizedHostname];
  return {
    hostname: normalizedHostname,
    mode: entry?.mode ?? getDefaultSitePolicy(normalizedHostname),
    explicit: Boolean(entry)
  };
}

async function setSitePolicy(hostname, mode) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    throw new Error("A hostname is required to set a site policy.");
  }

  if (!["allow", "ask", "block"].includes(mode)) {
    throw new Error(`Unsupported site policy mode: ${mode}`);
  }

  const policies = await getSitePolicies();
  policies[normalizedHostname] = {
    mode,
    updatedAt: new Date().toISOString()
  };
  await setSitePolicies(policies);

  return {
    hostname: normalizedHostname,
    mode
  };
}

async function getPendingApprovals() {
  const state = await chrome.storage.local.get([PENDING_APPROVALS_STORAGE_KEY]);
  return state[PENDING_APPROVALS_STORAGE_KEY] ?? [];
}

async function setPendingApprovals(approvals) {
  await chrome.storage.local.set({
    [PENDING_APPROVALS_STORAGE_KEY]: approvals
  });
}

async function listPendingApprovals() {
  return getPendingApprovals();
}

async function getSitePolicyStateForPanel() {
  const tab = await getTargetTab();
  let hostname = "";

  try {
    hostname = tab.url ? new URL(tab.url).hostname : "";
  } catch {
    hostname = "";
  }

  return resolveSitePolicy(hostname);
}

async function getWorkspaceArtifacts() {
  const state = await chrome.storage.local.get([WORKSPACE_ARTIFACTS_STORAGE_KEY]);
  return state[WORKSPACE_ARTIFACTS_STORAGE_KEY] ?? [];
}

async function setWorkspaceArtifacts(artifacts) {
  await chrome.storage.local.set({
    [WORKSPACE_ARTIFACTS_STORAGE_KEY]: artifacts
  });
}

async function recordWorkspaceArtifact({ type, tab, summary, details, workspaceId }) {
  const artifacts = await getWorkspaceArtifacts();
  let workspace = null;

  if (typeof workspaceId === "string" && workspaceId.length > 0) {
    workspace = await getWorkspaceById(workspaceId);
  } else {
    workspace = await getActiveWorkspace();
  }

  const artifact = {
    id: `artifact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    createdAt: new Date().toISOString(),
    workspaceId: workspace?.id ?? null,
    workspaceName: workspace?.name ?? null,
    tabId: tab?.id ?? null,
    url: tab?.url ?? null,
    title: tab?.title ?? null,
    summary,
    details
  };

  artifacts.push(artifact);
  if (artifacts.length > MAX_WORKSPACE_ARTIFACTS) {
    artifacts.splice(0, artifacts.length - MAX_WORKSPACE_ARTIFACTS);
  }

  await setWorkspaceArtifacts(artifacts);
  return artifact;
}

async function listWorkspaceArtifacts({ workspaceId, type, limit }) {
  const artifacts = await getWorkspaceArtifacts();
  const maxResults = Number.isInteger(limit) ? limit : 50;

  return artifacts
    .filter((artifact) => (workspaceId ? artifact.workspaceId === workspaceId : true))
    .filter((artifact) => (type ? artifact.type === type : true))
    .slice(-maxResults)
    .reverse();
}

async function getWorkspaceArtifact({ artifactId }) {
  if (typeof artifactId !== "string" || artifactId.length === 0) {
    throw new Error("artifactId is required.");
  }

  const artifacts = await getWorkspaceArtifacts();
  const artifact = artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) {
    throw new Error(`Artifact ${artifactId} was not found.`);
  }

  return artifact;
}

async function clearWorkspaceArtifacts({ workspaceId }) {
  const artifacts = await getWorkspaceArtifacts();
  const remaining = workspaceId ? artifacts.filter((artifact) => artifact.workspaceId !== workspaceId) : [];
  await setWorkspaceArtifacts(remaining);
  return {
    cleared: workspaceId ? artifacts.length - remaining.length : artifacts.length,
    workspaceId: workspaceId ?? null
  };
}

async function createPendingApproval({ tool, input, tab, hostname }) {
  const approvals = await getPendingApprovals();
  const approval = {
    id: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tool,
    hostname,
    tabId: tab?.id ?? null,
    summary: `${tool} on ${tab?.title || hostname}`,
    input,
    createdAt: new Date().toISOString()
  };
  approvals.push(approval);
  await setPendingApprovals(approvals);
  return approval;
}

async function resolvePolicyTarget(tool, input) {
  if (tool === "navigate" && typeof input?.url === "string") {
    try {
      const url = new URL(input.url);
      return {
        hostname: normalizeHostname(url.hostname),
        tab: null
      };
    } catch {
      return {
        hostname: "",
        tab: null
      };
    }
  }

  const tab = await getTargetTab(input?.tabId);
  let hostname = "";

  try {
    hostname = tab.url ? new URL(tab.url).hostname : "";
  } catch {
    hostname = "";
  }

  return {
    hostname: normalizeHostname(hostname),
    tab
  };
}

async function maybeRequireApproval(tool, input, context = {}) {
  if (context.skipApproval || !GUARDED_SITE_TOOLS.has(tool)) {
    return null;
  }

  const { hostname, tab } = await resolvePolicyTarget(tool, input);
  const policy = await resolveSitePolicy(hostname);

  if (policy.mode === "allow") {
    return null;
  }

  if (policy.mode === "block") {
    return {
      ok: false,
      message: `Blocked by site policy for ${policy.hostname || "this site"}.`
    };
  }

  const approval = await createPendingApproval({
    tool,
    input,
    tab,
    hostname: policy.hostname || hostname || "unknown"
  });

  return {
    ok: true,
    message: `Approval required for ${tool} on ${approval.hostname}.`,
    data: {
      approvalRequired: true,
      approvalId: approval.id,
      hostname: approval.hostname,
      tool
    }
  };
}

async function getWorkspaceState() {
  const state = await chrome.storage.local.get([
    WORKSPACE_STORAGE_KEY,
    ACTIVE_WORKSPACE_STORAGE_KEY
  ]);

  return {
    workspaces: state[WORKSPACE_STORAGE_KEY] ?? {},
    activeWorkspaceId: state[ACTIVE_WORKSPACE_STORAGE_KEY] ?? null
  };
}

async function reconcileWorkspaceState() {
  const state = await getWorkspaceState();
  const workspaces = { ...state.workspaces };
  let activeWorkspaceId = state.activeWorkspaceId;
  let changed = false;

  for (const [workspaceId, workspace] of Object.entries(workspaces)) {
    const tabs = await listWorkspaceTabs(workspace.groupId);
    if (tabs.length > 0) {
      continue;
    }

    delete workspaces[workspaceId];
    if (activeWorkspaceId === workspaceId) {
      activeWorkspaceId = null;
    }

    changed = true;
  }

  if (activeWorkspaceId && !workspaces[activeWorkspaceId]) {
    activeWorkspaceId = null;
    changed = true;
  }

  if (changed) {
    await setWorkspaceState(workspaces, activeWorkspaceId);
  }

  return {
    workspaces,
    activeWorkspaceId
  };
}

async function setWorkspaceState(workspaces, activeWorkspaceId) {
  await chrome.storage.local.set({
    [WORKSPACE_STORAGE_KEY]: workspaces,
    [ACTIVE_WORKSPACE_STORAGE_KEY]: activeWorkspaceId
  });
}

async function listWorkspaceTabs(groupId) {
  if (typeof groupId !== "number" || groupId < 0) {
    return [];
  }

  try {
    const tabs = await chrome.tabs.query({ groupId });
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      active: tab.active,
      windowId: tab.windowId,
      index: tab.index
    }));
  } catch {
    return [];
  }
}

async function listResolvedWorkspaceTabs(workspaceId) {
  const workspace = await resolveWorkspace(workspaceId);
  const tabs = await listWorkspaceTabs(workspace.groupId);
  return {
    workspace,
    tabs
  };
}

async function enrichWorkspace(workspace) {
  const tabs = await listWorkspaceTabs(workspace.groupId);
  return {
    ...workspace,
    tabCount: tabs.length,
    tabs
  };
}

async function getWorkspaceById(workspaceId) {
  const { workspaces } = await reconcileWorkspaceState();
  return workspaces[workspaceId] ?? null;
}

async function getActiveWorkspace() {
  const { workspaces, activeWorkspaceId } = await reconcileWorkspaceState();
  if (!activeWorkspaceId) {
    return null;
  }

  return workspaces[activeWorkspaceId] ?? null;
}

async function getWorkspaceStateSnapshot() {
  const { workspaces, activeWorkspaceId } = await reconcileWorkspaceState();
  const entries = await Promise.all(
    Object.values(workspaces).map(async (workspace) => {
      const enriched = await enrichWorkspace(workspace);
      return {
        ...enriched,
        active: workspace.id === activeWorkspaceId
      };
    })
  );

  return {
    activeWorkspaceId,
    workspaces: entries
  };
}

async function createWorkspaceSeedTab({ tabId, targetUrl }) {
  const seedTab =
    typeof tabId === "number"
      ? await chrome.tabs.get(tabId).catch(() => null)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null;

  const newTab = await chrome.tabs.create({
    url: targetUrl ?? seedTab?.url ?? "about:blank",
    windowId: seedTab?.windowId,
    index: typeof seedTab?.index === "number" ? seedTab.index + 1 : undefined,
    active: false
  });

  if (!newTab.id) {
    throw new Error("Failed to create the agent workspace tab.");
  }

  return newTab;
}

async function waitForTabToLoad(tabId, timeoutMs = 5000) {
  const existingTab = await chrome.tabs.get(tabId).catch(() => null);
  if (existingTab?.status === "complete") {
    return existingTab;
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = async () => {
      if (settled) {
        return;
      }

      settled = true;
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      chrome.tabs.onRemoved.removeListener(handleRemoved);
      clearTimeout(timeoutId);
      resolve(await chrome.tabs.get(tabId).catch(() => null));
    };

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === "complete") {
        void finish();
      }
    };

    const handleRemoved = (removedTabId) => {
      if (removedTabId !== tabId) {
        return;
      }

      void finish();
    };

    const timeoutId = setTimeout(() => {
      void finish();
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(handleUpdated);
    chrome.tabs.onRemoved.addListener(handleRemoved);
  });
}

async function createWorkspace({ name, color, tabId, targetUrl }) {
  const agentTab = await createWorkspaceSeedTab({ tabId, targetUrl });
  const workspaceId = generateWorkspaceId();
  const groupId = await chrome.tabs.group({ tabIds: [agentTab.id] });
  const tabGroup = await chrome.tabGroups.update(groupId, {
    title: name,
    color: color ?? DEFAULT_WORKSPACE_COLOR,
    collapsed: false
  });

  const workspace = {
    id: workspaceId,
    name,
    color: tabGroup.color,
    groupId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const { workspaces } = await getWorkspaceState();
  workspaces[workspaceId] = workspace;
  await setWorkspaceState(workspaces, workspaceId);
  return enrichWorkspace(workspace);
}

async function activateWorkspace(workspaceId) {
  const { workspaces } = await getWorkspaceState();
  const workspace = workspaces[workspaceId];
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} was not found.`);
  }

  workspace.updatedAt = new Date().toISOString();
  workspaces[workspaceId] = workspace;
  await setWorkspaceState(workspaces, workspaceId);
  return enrichWorkspace(workspace);
}

async function closeWorkspace(workspaceId, closeTabs) {
  const { workspaces, activeWorkspaceId } = await reconcileWorkspaceState();
  const workspace = workspaces[workspaceId];
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} was not found.`);
  }

  const tabs = await chrome.tabs.query({ groupId: workspace.groupId });
  const tabIds = tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number");

  if (tabIds.length > 0) {
    if (closeTabs) {
      await chrome.tabs.remove(tabIds);
    } else {
      await chrome.tabs.ungroup(tabIds);
    }
  }

  delete workspaces[workspaceId];
  await setWorkspaceState(workspaces, activeWorkspaceId === workspaceId ? null : activeWorkspaceId);
}

async function attachTabToWorkspace(workspaceId, tabId) {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} was not found.`);
  }

  if (typeof tabId !== "number") {
    throw new Error("tabId is required to attach an existing tab to a workspace.");
  }

  const targetTab = await chrome.tabs.get(tabId);
  if (!targetTab.id) {
    throw new Error("No target tab available.");
  }

  await chrome.tabs.group({
    groupId: workspace.groupId,
    tabIds: [targetTab.id]
  });

  return enrichWorkspace(workspace);
}

async function openTabInWorkspace({ workspaceId, url, active }) {
  const workspace = await resolveWorkspace(workspaceId);
  const workspaceTabs = await listWorkspaceTabs(workspace.groupId);
  const anchorTab = workspaceTabs[workspaceTabs.length - 1] ?? null;

  const newTab = await chrome.tabs.create({
    url,
    windowId: anchorTab?.windowId,
    index: typeof anchorTab?.index === "number" ? anchorTab.index + 1 : undefined,
    active: Boolean(active)
  });

  if (!newTab.id) {
    throw new Error("Failed to create a new tab in the workspace.");
  }

  await chrome.tabs.group({
    groupId: workspace.groupId,
    tabIds: [newTab.id]
  });

  const loadedTab = (await waitForTabToLoad(newTab.id)) ?? newTab;

  return {
    workspace: await enrichWorkspace(workspace),
    tab: {
      id: loadedTab.id,
      title: loadedTab.title,
      url: loadedTab.url,
      active: loadedTab.active
    }
  };
}

async function focusWorkspaceTab({ workspaceId, tabId }) {
  const workspace = await resolveWorkspace(workspaceId);
  const tabs = await listWorkspaceTabs(workspace.groupId);
  const targetTab = tabs.find((tab) => tab.id === tabId);

  if (!targetTab?.id) {
    throw new Error(`Tab ${tabId} is not part of workspace ${workspace.id}.`);
  }

  await chrome.tabs.update(targetTab.id, { active: true });

  return {
    workspace: await enrichWorkspace(workspace),
    tab: targetTab
  };
}

async function closeWorkspaceTab({ workspaceId, tabId }) {
  const workspace = await resolveWorkspace(workspaceId);
  const tabs = await listWorkspaceTabs(workspace.groupId);
  const targetTab = tabs.find((tab) => tab.id === tabId);

  if (!targetTab?.id) {
    throw new Error(`Tab ${tabId} is not part of workspace ${workspace.id}.`);
  }

  await chrome.tabs.remove(targetTab.id);
  await reconcileWorkspaceState();

  return {
    workspaceId: workspace.id,
    closedTabId: targetTab.id
  };
}

async function focusWorkspace(workspaceId) {
  const workspace = await resolveWorkspace(workspaceId);
  const tabs = await listWorkspaceTabs(workspace.groupId);
  const targetTab = tabs.find((tab) => tab.active) ?? tabs[0];

  if (!targetTab?.id || typeof targetTab.windowId !== "number") {
    throw new Error(`Workspace ${workspace.id} does not have a focusable tab.`);
  }

  await chrome.windows.update(targetTab.windowId, { focused: true });
  await chrome.tabs.update(targetTab.id, { active: true });
  await waitForDelay(100);
  const refreshedTab = await chrome.tabs.get(targetTab.id);

  return {
    workspace: await enrichWorkspace(workspace),
    tab: refreshedTab
  };
}

async function readAllTabsInWorkspace({ workspaceId, mode }) {
  const { workspace, tabs } = await listResolvedWorkspaceTabs(workspaceId);
  const tabSnapshots = [];

  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }

    const result = await sendPageCommand(tab.id, {
      type: "read_page",
      mode: mode ?? "interactive"
    });

    tabSnapshots.push({
      tabId: tab.id,
      title: result.data?.title || tab.title,
      url: tab.url,
      active: tab.active,
      page: {
        ...result.data,
        title: result.data?.title || tab.title || ""
      }
    });
  }

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    tabs: tabSnapshots
  };
}

async function collectDataAcrossTabs({ workspaceId, role, labelContains }) {
  const { tabs } = await listResolvedWorkspaceTabs(workspaceId);
  const matches = [];

  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }

    const result = await sendPageCommand(tab.id, {
      type: "find_elements",
      role,
      labelContains
    });

    if (!result.ok || !Array.isArray(result.data)) {
      continue;
    }

    for (const element of result.data) {
      matches.push({
        tabId: tab.id,
        tabTitle: tab.title ?? "",
        tabUrl: tab.url ?? "",
        ...element
      });
    }
  }

  return matches;
}

async function listWorkspaces() {
  const { workspaces, activeWorkspaceId } = await reconcileWorkspaceState();
  const entries = await Promise.all(Object.values(workspaces).map((workspace) => enrichWorkspace(workspace)));
  return entries.map((workspace) => ({
    ...workspace,
    active: workspace.id === activeWorkspaceId
  }));
}

async function listTabsWithinScope() {
  const activeWorkspace = await requireActiveWorkspace();
  const tabs = await listWorkspaceTabs(activeWorkspace.groupId);
  return tabs.map((tab) => ({
    ...tab,
    workspaceId: activeWorkspace.id
  }));
}

async function listWorkspaceGroups() {
  const { workspaces, activeWorkspaceId } = await reconcileWorkspaceState();
  const entries = [];

  for (const workspace of Object.values(workspaces)) {
    let group = null;
    try {
      group = await chrome.tabGroups.get(workspace.groupId);
    } catch {
      group = null;
    }

    const tabs = await listWorkspaceTabs(workspace.groupId);
    entries.push({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      active: workspace.id === activeWorkspaceId,
      groupId: workspace.groupId,
      color: group?.color ?? workspace.color ?? null,
      title: group?.title ?? workspace.name,
      collapsed: group?.collapsed ?? false,
      windowId: group?.windowId ?? tabs[0]?.windowId ?? null,
      tabCount: tabs.length
    });
  }

  return entries;
}

async function decideApproval(approvalId, decision) {
  const approvals = await getPendingApprovals();
  const approval = approvals.find((entry) => entry.id === approvalId);

  if (!approval) {
    throw new Error(`Approval ${approvalId} was not found.`);
  }

  const remaining = approvals.filter((entry) => entry.id !== approvalId);
  await setPendingApprovals(remaining);

  if (decision !== "approve") {
    return {
      approvalId,
      approved: false
    };
  }

  return executeCommand(
    {
      tool: approval.tool,
      input: approval.input ?? {}
    },
    { skipApproval: true }
  );
}

async function ensureDebuggerSession(tabId) {
  if (!debuggerSessions.has(tabId)) {
    debuggerSessions.set(tabId, {
      logs: [],
      errors: [],
      networkCapture: false,
      networkRequests: [],
      requestsById: new Map()
    });
  }

  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    const message = String(error);
    if (!message.includes("Another debugger is already attached")) {
      throw error;
    }
  }

  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  await chrome.debugger.sendCommand({ tabId }, "Log.enable");

  return debuggerSessions.get(tabId);
}

async function getConsoleLogs({ tabId, clear }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for console log capture.");
  }

  const session = await ensureDebuggerSession(tab.id);
  const logs = [...(session?.logs ?? [])];

  if (clear && session) {
    session.logs = [];
  }

  await recordWorkspaceArtifact({
    type: "console_logs",
    tab,
    summary: `Captured ${logs.length} console log entries.`,
    details: {
      count: logs.length,
      preview: logs.slice(-10)
    }
  });

  return logs;
}

async function startNetworkCapture({ tabId, clear }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for network capture.");
  }

  const session = await ensureDebuggerSession(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Network.enable");
  session.networkCapture = true;

  if (clear) {
    session.networkRequests = [];
    session.requestsById = new Map();
  }

  return {
    tabId: tab.id,
    capturing: true
  };
}

async function stopNetworkCapture({ tabId }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for network capture.");
  }

  const session = await ensureDebuggerSession(tab.id);
  session.networkCapture = false;

  return {
    tabId: tab.id,
    capturing: false
  };
}

async function getLastRequests({ tabId, limit }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for network request capture.");
  }

  const session = await ensureDebuggerSession(tab.id);
  const maxResults = Number.isInteger(limit) ? limit : 20;
  const requests = session.networkRequests.slice(-maxResults);

  await recordWorkspaceArtifact({
    type: "network_requests",
    tab,
    summary: `Captured ${requests.length} recent network requests.`,
    details: {
      count: requests.length,
      preview: requests.slice(-10)
    }
  });

  return requests;
}

async function getLastErrors({ tabId, limit }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for error capture.");
  }

  const session = await ensureDebuggerSession(tab.id);
  const maxResults = Number.isInteger(limit) ? limit : 20;
  const errors = session.errors.slice(-maxResults);

  await recordWorkspaceArtifact({
    type: "page_errors",
    tab,
    summary: `Captured ${errors.length} recent page errors.`,
    details: {
      count: errors.length,
      preview: errors.slice(-10)
    }
  });

  return errors;
}

async function getPerformanceSnapshot({ tabId }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for performance capture.");
  }

  await ensureDebuggerSession(tab.id);
  await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.enable");
  const result = await chrome.debugger.sendCommand({ tabId: tab.id }, "Performance.getMetrics");
  const metrics = {};

  for (const entry of result.metrics ?? []) {
    if (typeof entry?.name === "string" && typeof entry?.value === "number") {
      metrics[entry.name] = entry.value;
    }
  }

  await recordWorkspaceArtifact({
    type: "performance_snapshot",
    tab,
    summary: `Captured ${Object.keys(metrics).length} performance metrics.`,
    details: {
      metricCount: Object.keys(metrics).length,
      metricNames: Object.keys(metrics).slice(0, 20)
    }
  });

  return metrics;
}

async function inspectDomNode({ tabId, ref }) {
  const tab = await getTargetTab(tabId);
  return sendPageCommand(tab.id, {
    type: "inspect_dom_node",
    ref
  });
}

async function inspectCssRules({ tabId, ref }) {
  const tab = await getTargetTab(tabId);
  return sendPageCommand(tab.id, {
    type: "inspect_css_rules",
    ref
  });
}

async function highlightElements({ tabId, role, labelContains }) {
  const tab = await getTargetTab(tabId);
  return sendPageCommand(tab.id, {
    type: "highlight_elements",
    role,
    labelContains
  });
}

async function clearHighlights({ tabId }) {
  const tab = await getTargetTab(tabId);
  return sendPageCommand(tab.id, {
    type: "clear_highlights"
  });
}

async function captureFullPageScreenshot({ tabId }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for full-page capture.");
  }

  const result = await withActivityOverlaySuspended(tab.id, async () => {
    await ensureDebuggerSession(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
    const metrics = await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.getLayoutMetrics");
    const contentSize = metrics.cssContentSize ?? metrics.contentSize;
    const clip = contentSize
      ? {
          x: 0,
          y: 0,
          width: Math.max(1, Math.ceil(contentSize.width)),
          height: Math.max(1, Math.ceil(contentSize.height)),
          scale: 1
        }
      : undefined;

    try {
      return await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip
      });
    } catch {
      return chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true
      });
    }
  });

  const artifact = {
    tabId: tab.id,
    dataUrl: `data:image/png;base64,${result.data}`
  };
  await recordWorkspaceArtifact({
    type: "screenshot_full_page",
    tab,
    summary: "Captured a full-page screenshot.",
    details: {
      dataUrlLength: artifact.dataUrl.length
    }
  });
  return artifact;
}

async function captureElementScreenshot({ tabId, ref }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for element capture.");
  }

  const inspection = await sendPageCommand(tab.id, {
    type: "inspect_dom_node",
    ref
  });

  const rect = inspection.data?.rect;
  if (!rect || typeof rect.width !== "number" || typeof rect.height !== "number") {
    throw new Error(`Could not resolve element bounds for ${ref}.`);
  }

  const result = await withActivityOverlaySuspended(tab.id, async () => {
    await ensureDebuggerSession(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.enable");
    return chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: Math.max(0, rect.x),
        y: Math.max(0, rect.y),
        width: Math.max(1, Math.ceil(rect.width)),
        height: Math.max(1, Math.ceil(rect.height)),
        scale: 1
      }
    });
  });

  const artifact = {
    tabId: tab.id,
    ref,
    dataUrl: `data:image/png;base64,${result.data}`,
    rect
  };
  await recordWorkspaceArtifact({
    type: "screenshot_element",
    tab,
    summary: `Captured element screenshot for ${ref}.`,
    details: {
      ref,
      rect,
      dataUrlLength: artifact.dataUrl.length
    }
  });
  return artifact;
}

async function captureLabeledScreenshot({ tabId }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for labeled capture.");
  }

  let labeledCount = 0;

  try {
    const overlay = await sendPageCommand(tab.id, {
      type: "show_debug_labels"
    });
    labeledCount = overlay.data?.labeledCount ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const screenshot = await captureFullPageScreenshot({ tabId: tab.id });
    const artifact = {
      ...screenshot,
      labeledCount
    };
    await recordWorkspaceArtifact({
      type: "screenshot_with_labels",
      tab,
      summary: `Captured labeled screenshot with ${labeledCount} labels.`,
      details: {
        labeledCount,
        dataUrlLength: artifact.dataUrl.length
      }
    });
    return artifact;
  } finally {
    await sendPageCommand(tab.id, {
      type: "hide_debug_labels"
    }).catch(() => {});
  }
}

async function applyViewportProfile(tabId, profile) {
  await ensureDebuggerSession(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: profile.width,
    height: profile.height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.mobile
  });
}

async function clearViewportOverride(tabId) {
  await ensureDebuggerSession(tabId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
}

async function captureDebuggerViewportScreenshot(tabId) {
  const result = await withActivityOverlaySuspended(tabId, async () => {
    await ensureDebuggerSession(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    return chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true
    });
  });

  return `data:image/png;base64,${result.data}`;
}

async function analyzeResponsiveBreakpoints({ tabId, mode }) {
  const tab = await getTargetTab(tabId);
  if (!tab.id) {
    throw new Error("No tab available for responsive analysis.");
  }

  const results = [];

  try {
    for (const profile of RESPONSIVE_PROFILES) {
      await applyViewportProfile(tab.id, profile);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const page = await sendPageCommand(tab.id, {
        type: "read_page",
        mode: mode ?? "interactive"
      });
      const layoutInspection = await sendPageCommand(tab.id, {
        type: "inspect_layout_issues",
        expectedViewportWidth: profile.width,
        expectedViewportHeight: profile.height
      });
      const screenshotDataUrl = await captureDebuggerViewportScreenshot(tab.id);
      const snapshotArtifact = await recordWorkspaceArtifact({
        type: "responsive_snapshot",
        tab,
        summary: `Captured a ${profile.name} responsive snapshot.`,
        details: {
          profile: profile.name,
          requestedViewport: {
            width: profile.width,
            height: profile.height,
            mobile: profile.mobile
          },
          viewport: page.data?.viewport ?? null,
          dataUrl: screenshotDataUrl,
          dataUrlLength: screenshotDataUrl.length
        }
      });

      results.push({
        profile: profile.name,
        requestedViewport: {
          width: profile.width,
          height: profile.height,
          mobile: profile.mobile
        },
        viewport: page.data?.viewport ?? null,
        headingCount: Array.isArray(page.data?.headings) ? page.data.headings.length : 0,
        landmarkCount: Array.isArray(page.data?.landmarks) ? page.data.landmarks.length : 0,
        interactiveCount: Array.isArray(page.data?.interactiveElements) ? page.data.interactiveElements.length : 0,
        layoutIssues: layoutInspection.data,
        snapshotArtifactId: snapshotArtifact.id
      });
    }
  } finally {
    await clearViewportOverride(tab.id).catch(() => {});
  }

  await recordWorkspaceArtifact({
    type: "responsive_analysis",
    tab,
    summary: `Captured responsive analysis for ${results.length} breakpoints.`,
    details: {
      profiles: results.map((entry) => ({
        profile: entry.profile,
        interactiveCount: entry.interactiveCount,
        headingCount: entry.headingCount,
        issueCount: Array.isArray(entry.layoutIssues?.issues) ? entry.layoutIssues.issues.length : 0,
        snapshotArtifactId: entry.snapshotArtifactId ?? null
      }))
    }
  });

  return results;
}

async function executeCommand(command, context = {}) {
  switch (command.tool) {
    case "workspace_create": {
      const workspace = await createWorkspace(command.input);
      return {
        ok: true,
        message: `Workspace ${workspace.name} created.`,
        data: workspace
      };
    }
    case "workspace_list":
      return {
        ok: true,
        message: "Workspaces listed.",
        data: await listWorkspaces()
      };
    case "workspace_activate": {
      const workspace = await activateWorkspace(command.input.workspaceId);
      return {
        ok: true,
        message: `Workspace ${workspace.id} activated.`,
        data: workspace
      };
    }
    case "workspace_close":
      await closeWorkspace(command.input.workspaceId, Boolean(command.input.closeTabs));
      return {
        ok: true,
        message: `Workspace ${command.input.workspaceId} closed.`
      };
    case "tab_attach_to_workspace": {
      const workspace = await attachTabToWorkspace(command.input.workspaceId, command.input.tabId);
      return {
        ok: true,
        message: `Tab attached to workspace ${workspace.id}.`,
        data: workspace
      };
    }
    case "tab_open": {
      const result = await openTabInWorkspace(command.input);
      return {
        ok: true,
        message: `Opened a new workspace tab for ${command.input.url}.`,
        data: result
      };
    }
    case "tab_focus": {
      const result = await focusWorkspaceTab(command.input);
      return {
        ok: true,
        message: `Focused tab ${command.input.tabId}.`,
        data: result
      };
    }
    case "tab_close": {
      const result = await closeWorkspaceTab(command.input);
      return {
        ok: true,
        message: `Closed tab ${command.input.tabId}.`,
        data: result
      };
    }
    case "tabs_list":
      return {
        ok: true,
        message: "Tabs listed.",
        data: await listTabsWithinScope()
      };
    case "tab_group_list":
      return {
        ok: true,
        message: "Tab groups listed.",
        data: await listWorkspaceGroups()
      };
    case "site_policy_list":
      return {
        ok: true,
        message: "Site policies listed.",
        data: await listSitePolicies()
      };
    case "site_policy_set":
      return {
        ok: true,
        message: "Site policy updated.",
        data: await setSitePolicy(command.input.hostname, command.input.mode)
      };
    case "approval_list":
      return {
        ok: true,
        message: "Pending approvals listed.",
        data: await listPendingApprovals()
      };
    case "approval_decide":
      return decideApproval(command.input.approvalId, command.input.decision);
    case "artifact_list":
      return {
        ok: true,
        message: "Workspace artifacts listed.",
        data: await listWorkspaceArtifacts(command.input)
      };
    case "artifact_get":
      return {
        ok: true,
        message: "Workspace artifact retrieved.",
        data: await getWorkspaceArtifact(command.input)
      };
    case "artifact_clear":
      return {
        ok: true,
        message: "Workspace artifacts cleared.",
        data: await clearWorkspaceArtifacts(command.input)
      };
    case "read_all_tabs_in_workspace":
      return {
        ok: true,
        message: "Read all tabs in workspace.",
        data: await readAllTabsInWorkspace(command.input)
      };
    case "collect_data_across_tabs":
      return {
        ok: true,
        message: "Collected data across tabs.",
        data: await collectDataAcrossTabs(command.input)
      };
    case "navigate": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      await chrome.tabs.update(tab.id, { url: command.input.url });
      return {
        ok: true,
        message: `Navigated to ${command.input.url}.`
      };
    }
    case "read_page": {
      const tab = await getTargetTab(command.input.tabId);
      const result = await sendPageCommand(tab.id, {
        type: "read_page",
        mode: command.input.mode ?? "interactive"
      });

      return {
        ok: true,
        message: "Page read complete.",
        data: result.data
      };
    }
    case "get_accessibility_tree": {
      const tab = await getTargetTab(command.input.tabId);
      const result = await sendPageCommand(tab.id, {
        type: "get_accessibility_tree"
      });

      return {
        ok: true,
        message: "Accessibility tree captured.",
        data: result.data
      };
    }
    case "find_elements": {
      const tab = await getTargetTab(command.input.tabId);
      const result = await sendPageCommand(tab.id, {
        type: "find_elements",
        role: command.input.role,
        labelContains: command.input.labelContains
      });

      return {
        ok: true,
        message: "Element search complete.",
        data: result.data
      };
    }
    case "wait_for": {
      const tab = await getTargetTab(command.input.tabId);
      const timeoutMs = Number(command.input.timeoutMs ?? 5000);
      const pollIntervalMs = Math.max(25, Number(command.input.pollIntervalMs ?? 100));
      const result = await sendPageCommand(tab.id, {
        type: "wait_for",
        ref: command.input.ref,
        selector: command.input.selector,
        role: command.input.role,
        labelContains: command.input.labelContains,
        textContains: command.input.textContains,
        timeoutMs,
        pollIntervalMs
      });

      if (result?.ok && result?.data?.matched) {
        return {
          ok: true,
          message: "Wait condition satisfied.",
          data: result.data
        };
      }

      return {
        ok: false,
        message: `Timed out after ${timeoutMs}ms waiting for the requested page state.`,
        data: result?.data ?? { matched: false, waitedMs: timeoutMs }
      };
    }
    case "highlight_elements": {
      const result = await highlightElements(command.input);
      return {
        ok: true,
        message: "Elements highlighted.",
        data: result.data
      };
    }
    case "clear_highlights": {
      const result = await clearHighlights(command.input);
      return {
        ok: true,
        message: "Highlights removed.",
        data: result.data
      };
    }
    case "inspect_dom_node": {
      const result = await inspectDomNode(command.input);
      return {
        ok: true,
        message: "DOM node inspection complete.",
        data: result.data
      };
    }
    case "inspect_css_rules": {
      const result = await inspectCssRules(command.input);
      return {
        ok: true,
        message: "CSS inspection complete.",
        data: result.data
      };
    }
    case "click": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "click",
        ref: command.input.ref
      });
    }
    case "type": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "type",
        ref: command.input.ref,
        text: command.input.text
      });
    }
    case "clear_input": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "clear_input",
        ref: command.input.ref
      });
    }
    case "select_option": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "select_option",
        ref: command.input.ref,
        value: command.input.value,
        label: command.input.label,
        index: command.input.index
      });
    }
    case "toggle_checkbox": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "toggle_checkbox",
        ref: command.input.ref
      });
    }
    case "form_fill": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "form_fill",
        fields: command.input.fields
      });
    }
    case "upload_file": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "upload_file",
        ref: command.input.ref,
        file: command.input.file
      });
    }
    case "press_keys": {
      const approval = await maybeRequireApproval(command.tool, command.input, context);
      if (approval) {
        return approval;
      }
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "press_keys",
        keys: command.input.keys,
        ref: command.input.ref
      });
    }
    case "hover": {
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "hover",
        ref: command.input.ref
      });
    }
    case "scroll": {
      const tab = await getTargetTab(command.input.tabId);
      return sendPageCommand(tab.id, {
        type: "scroll",
        x: command.input.x,
        y: command.input.y,
        behavior: command.input.behavior
      });
    }
    case "get_console_logs": {
      return {
        ok: true,
        message: "Console logs captured.",
        data: await getConsoleLogs(command.input)
      };
    }
    case "start_network_capture": {
      return {
        ok: true,
        message: "Network capture started.",
        data: await startNetworkCapture(command.input)
      };
    }
    case "stop_network_capture": {
      return {
        ok: true,
        message: "Network capture stopped.",
        data: await stopNetworkCapture(command.input)
      };
    }
    case "get_last_requests": {
      return {
        ok: true,
        message: "Network requests captured.",
        data: await getLastRequests(command.input)
      };
    }
    case "get_last_errors": {
      return {
        ok: true,
        message: "Recent page errors captured.",
        data: await getLastErrors(command.input)
      };
    }
    case "performance_snapshot": {
      return {
        ok: true,
        message: "Performance snapshot captured.",
        data: await getPerformanceSnapshot(command.input)
      };
    }
    case "screenshot_full_page": {
      return {
        ok: true,
        message: "Full-page screenshot captured.",
        data: await captureFullPageScreenshot(command.input)
      };
    }
    case "screenshot_element": {
      return {
        ok: true,
        message: "Element screenshot captured.",
        data: await captureElementScreenshot(command.input)
      };
    }
    case "screenshot_with_labels": {
      return {
        ok: true,
        message: "Labeled screenshot captured.",
        data: await captureLabeledScreenshot(command.input)
      };
    }
    case "analyze_responsive_breakpoints": {
      return {
        ok: true,
        message: "Responsive breakpoint analysis complete.",
        data: await analyzeResponsiveBreakpoints(command.input)
      };
    }
    case "screenshot_viewport": {
      const tab = await getTargetTab(command.input.tabId);
      const image = await withActivityOverlaySuspended(tab.id, async () => {
        await activateTabForCapture(tab.id);
        return chrome.tabs.captureVisibleTab(tab.windowId, {
          format: "png"
        });
      });
      const artifact = {
        tabId: tab.id,
        dataUrl: image
      };

      await recordWorkspaceArtifact({
        type: "screenshot_viewport",
        tab,
        summary: "Captured a viewport screenshot.",
        details: {
          dataUrlLength: image.length
        }
      });

      return {
        ok: true,
        message: "Viewport captured.",
        data: artifact
      };
    }
    default:
      return {
        ok: false,
        message: `Unsupported tool: ${command.tool}`
      };
  }
}

async function pollRelayOnce() {
  let response;
  const relayConnection = await resolveRelayConnection();

  if (!relayConnection) {
    await updateRelayHealth(false);
    throw new Error(
      `Could not find a browser-ext-mcp relay in ports ${DEFAULT_RELAY_PORT}-${DEFAULT_RELAY_PORT + RELAY_PORT_SCAN_LIMIT - 1}.`
    );
  }

  try {
    response = await fetch(`${relayConnection.url}/pull`, {
      headers: await getRelayAuthHeaders(relayConnection)
    });
  } catch (error) {
    await updateRelayHealth(false);
    throw error;
  }

  if (response.status === 401) {
    await clearRelayPairing();
    response = await fetch(`${relayConnection.url}/pull`, {
      headers: await getRelayAuthHeaders(relayConnection, { forceRefresh: true })
    });
  }

  await updateRelayHealth(response.ok || response.status === 204);

  if (response.status === 204) {
    await updateRelayBusy(false);
    await notifyRelayActivity(false);
    return { polled: true, executed: false };
  }

  if (!response.ok) {
    throw new Error(`Relay returned HTTP ${response.status}`);
  }

  const command = await response.json();
  let result;
  const activityTabIds = await getActivityOverlayTabIds(command);
  const jobId = normalizeActivityJobId(command.jobId);
  const trackedActivityTabIds = jobId ? mergeTrackedJobTabIds(jobId, activityTabIds) : activityTabIds;

  try {
    await updateRelayBusy(true);
    void ensureRelayEventStreamReady().catch(() => {});
    await notifyRelayActivity(true, command.tool);
    await Promise.all(
      trackedActivityTabIds.map((tabId) => showActivityOverlayOnTab(tabId, `Codex · ${command.tool}`))
    );
    result = await executeCommand(command);
  } catch (error) {
    result = {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (jobId && command.jobEnd === true) {
      const tabIdsToClear = consumeTrackedJobTabIds(jobId, activityTabIds);
      await Promise.all(tabIdsToClear.map((tabId) => clearActivityOverlayOnTab(tabId)));
    }
    await updateRelayBusy(false);
    await notifyRelayActivity(false, command.tool);
  }

  await postResult({
    requestId: command.requestId,
    ok: result.ok,
    message: result.message,
    data: result.data
  });

  return { polled: true, executed: true, tool: command.tool };
}

async function drainRelayQueue({ maxCommands = 5 } = {}) {
  if (relayPollInFlight) {
    return { executed: 0, skipped: true };
  }

  relayPollInFlight = true;

  try {
    let executed = 0;

    for (; executed < maxCommands; executed += 1) {
      const result = await pollRelayOnce();
      if (!result?.executed) {
        return { executed, idle: true };
      }
    }

    return { executed, drained: true };
  } catch (error) {
    await updateRelayHealth(false);
    await updateRelayBusy(false);
    await notifyRelayActivity(false);
    return {
      executed: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    relayPollInFlight = false;
  }
}
