const relayStatusNode = document.getElementById("relay-status");
const relayPortInput = document.getElementById("relay-port");
const saveRelayPortButton = document.getElementById("save-relay-port");
const activeTabNode = document.getElementById("active-tab");
const refreshButton = document.getElementById("refresh-status");
const siteHostnameInput = document.getElementById("site-hostname");
const sitePolicySelect = document.getElementById("site-policy");
const saveSitePolicyButton = document.getElementById("save-site-policy");
const createWorkspaceButton = document.getElementById("create-workspace");
const activeWorkspaceNode = document.getElementById("active-workspace");
const sessionCopyNode = document.getElementById("session-copy");
const focusWorkspaceButton = document.getElementById("focus-workspace");
const closeWorkspaceButton = document.getElementById("close-workspace");
const workspaceListNode = document.getElementById("workspace-list");
const approvalListNode = document.getElementById("approval-list");
const approvalStateNode = document.getElementById("approval-state");
const approvalModalNode = document.getElementById("approval-modal");
const approvalModalSummaryNode = document.getElementById("approval-modal-summary");
const approvalModalHostnameNode = document.getElementById("approval-modal-hostname");
const approvalModalToolNode = document.getElementById("approval-modal-tool");
const approvalModalInputNode = document.getElementById("approval-modal-input");
const approvalApproveOnceButton = document.getElementById("approval-approve-once");
const approvalAllowSiteButton = document.getElementById("approval-allow-site");
const approvalDenyButton = document.getElementById("approval-deny");
const urlParams = new URLSearchParams(window.location.search);
const overrideTabId = urlParams.has("tab") ? Number(urlParams.get("tab")) : null;
const overrideTargetUrl = urlParams.get("targetUrl");
let currentActiveWorkspaceId = null;
let currentApproval = null;
let panelHeartbeatId = null;

function buildDefaultSessionName() {
  const target = overrideTargetUrl;
  if (target) {
    try {
      return `Agent Session · ${new URL(target).hostname}`;
    } catch {}
  }

  return "Agent Session";
}

function setRelayVisualState(state) {
  document.body.dataset.relay = state;
}

function setActivityVisualState(state) {
  document.body.dataset.activity = state;
}

function setText(node, value) {
  node.textContent = value;
}

function stringifyApprovalInput(input) {
  if (!input || typeof input !== "object") {
    return "{}";
  }

  return JSON.stringify(input, null, 2);
}

function setApprovalModalVisible(visible) {
  approvalModalNode.classList.toggle("hidden", !visible);
  approvalModalNode.setAttribute("aria-hidden", visible ? "false" : "true");
  document.body.dataset.approvalOpen = visible ? "true" : "false";
}

function renderApprovalModal(approval) {
  currentApproval = approval ?? null;

  if (!approval) {
    setApprovalModalVisible(false);
    return;
  }

  setText(approvalModalSummaryNode, approval.summary || "This action needs your confirmation.");
  setText(approvalModalHostnameNode, approval.hostname || "Unknown");
  setText(approvalModalToolNode, approval.tool || "Unknown");
  setText(approvalModalInputNode, stringifyApprovalInput(approval.input));
  setApprovalModalVisible(true);
}

async function decideApproval(approvalId, decision) {
  await chrome.runtime.sendMessage({
    type: "approval-decide",
    approvalId,
    decision
  });
}

async function allowSiteAndApproveCurrent() {
  if (!currentApproval?.hostname || !currentApproval?.id) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "set-site-policy",
    hostname: currentApproval.hostname,
    mode: "allow"
  });
  await decideApproval(currentApproval.id, "approve");
}

async function loadRelayConfig() {
  const response = await chrome.runtime.sendMessage({ type: "get-relay-config" });
  const config = response?.result;
  if (!config) {
    return;
  }

  relayPortInput.value = String(config.port);
  relayPortInput.placeholder = String(config.defaultPort);
}

async function loadRelayStatus() {
  const state = await chrome.storage.local.get([
    "relayHealthy",
    "relayBusy",
    "relayPairingToken",
    "relayPairingPort"
  ]);
  const relayHealthy = state.relayHealthy === true;
  const relayBusy = state.relayBusy === true;
  const hasPairing =
    typeof state.relayPairingToken === "string" &&
    Number.isInteger(state.relayPairingPort);
  const sleeping = relayHealthy && !relayBusy && hasPairing;
  const statusLabel =
    relayHealthy ?
      relayBusy ?
        "Connected · Working"
      : sleeping ?
        "Connected · Standby"
      : "Connected"
    : "Offline";

  setText(relayStatusNode, statusLabel);
  setRelayVisualState(relayHealthy ? "connected" : "offline");
  setActivityVisualState(relayBusy ? "working" : "idle");
}

async function loadActiveTab() {
  if (Number.isInteger(overrideTabId)) {
    const tab = await chrome.tabs.get(overrideTabId);
    setText(activeTabNode, tab?.title ? `${tab.title}` : "No active tab found");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "get-active-tab" });
  const tab = response?.tab;
  setText(activeTabNode, tab?.title ? `${tab.title}` : "No active tab found");
}

async function loadSitePolicyState() {
  const response = await chrome.runtime.sendMessage({ type: "get-site-policy-state" }).catch(() => null);
  const result = response?.result;

  siteHostnameInput.value = result?.hostname ?? "";
  sitePolicySelect.value = result?.mode ?? "allow";
  saveSitePolicyButton.disabled = !result?.hostname;
}

async function loadWorkspaceState() {
  const response = await chrome.runtime.sendMessage({ type: "get-workspace-state" });
  const state = response?.result;
  const workspaces = state?.workspaces ?? [];
  const activeWorkspace = workspaces.find((workspace) => workspace.id === state?.activeWorkspaceId) ?? null;
  currentActiveWorkspaceId = activeWorkspace?.id ?? null;
  focusWorkspaceButton.disabled = !currentActiveWorkspaceId;
  closeWorkspaceButton.disabled = !currentActiveWorkspaceId;
  createWorkspaceButton.disabled = Boolean(currentActiveWorkspaceId);
  createWorkspaceButton.textContent = currentActiveWorkspaceId ? "Session ready" : "Prepare session";

  setText(
    activeWorkspaceNode,
    activeWorkspace ? `${activeWorkspace.name} · ${activeWorkspace.tabCount} tabs` : "No active agent session"
  );

  setText(
    sessionCopyNode,
    activeWorkspace
      ? "Review the agent tabs here, bring them to the front, or close everything at once."
      : "The agent will create and use its own session. You only need to review, focus, or clean it up."
  );

  workspaceListNode.replaceChildren();

  if (!activeWorkspace) {
    const item = document.createElement("li");
    item.className = "session-empty";
    item.textContent = "No agent tabs yet.";
    workspaceListNode.appendChild(item);
    return;
  }

  const tabs = Array.isArray(activeWorkspace.tabs) ? activeWorkspace.tabs : [];
  for (const tab of tabs) {
    const item = document.createElement("li");
    const details = document.createElement("div");
    details.className = "tool-list-copy";
    const label = document.createElement("span");
    label.textContent = tab.title || tab.url || "Untitled tab";
    details.appendChild(label);

    if (tab.url) {
      const tabsPreview = document.createElement("p");
      tabsPreview.className = "session-tabs-copy";
      tabsPreview.textContent = tab.url;
      details.appendChild(tabsPreview);
    }

    item.appendChild(details);

    const actions = document.createElement("div");
    actions.className = "inline-actions";

    const focusButton = document.createElement("button");
    focusButton.type = "button";
    focusButton.className = "ghost-button";
    focusButton.textContent = "Focus";
    focusButton.disabled = typeof tab.id !== "number";
    focusButton.addEventListener("click", async () => {
      if (typeof tab.id !== "number") {
        return;
      }

      await chrome.runtime.sendMessage({
        type: "workspace-focus-tab",
        workspaceId: activeWorkspace.id,
        tabId: tab.id
      });
      await loadWorkspaceState();
      await loadActiveTab();
    });
    actions.appendChild(focusButton);

    item.appendChild(actions);

    workspaceListNode.appendChild(item);
  }
}

async function loadApprovals() {
  const response = await chrome.runtime.sendMessage({ type: "get-approvals" }).catch(() => null);
  const approvals = response?.result ?? [];

  approvalListNode.replaceChildren();

  if (approvals.length === 0) {
    setText(approvalStateNode, "No pending approvals");
    renderApprovalModal(null);
    return;
  }

  setText(
    approvalStateNode,
    approvals.length === 1 ? "1 sensitive action is waiting for you" : `${approvals.length} sensitive actions are waiting`
  );
  renderApprovalModal(approvals[0]);

  for (const approval of approvals) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${approval.tool} · ${approval.hostname} · ${approval.summary}`;
    item.appendChild(label);

    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.className = "ghost-button";
    approveButton.textContent = "Approve";
    approveButton.addEventListener("click", async () => {
      await decideApproval(approval.id, "approve");
      await Promise.allSettled([loadApprovals(), loadRelayStatus(), loadWorkspaceState()]);
    });
    item.appendChild(approveButton);

    const denyButton = document.createElement("button");
    denyButton.type = "button";
    denyButton.className = "ghost-button";
    denyButton.textContent = "Deny";
    denyButton.addEventListener("click", async () => {
      await decideApproval(approval.id, "deny");
      await loadApprovals();
    });
    item.appendChild(denyButton);

    approvalListNode.appendChild(item);
  }
}

refreshButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "ensure-relay-stream" }).catch(() => null);
  await Promise.allSettled([
    loadRelayConfig(),
    loadRelayStatus(),
    loadActiveTab(),
    loadSitePolicyState(),
    loadWorkspaceState(),
    loadApprovals()
  ]);
});

approvalApproveOnceButton.addEventListener("click", async () => {
  if (!currentApproval?.id) {
    return;
  }

  await decideApproval(currentApproval.id, "approve");
  await Promise.allSettled([loadApprovals(), loadRelayStatus(), loadWorkspaceState(), loadSitePolicyState()]);
});

approvalAllowSiteButton.addEventListener("click", async () => {
  await allowSiteAndApproveCurrent();
  await Promise.allSettled([loadApprovals(), loadRelayStatus(), loadWorkspaceState(), loadSitePolicyState()]);
});

approvalDenyButton.addEventListener("click", async () => {
  if (!currentApproval?.id) {
    return;
  }

  await decideApproval(currentApproval.id, "deny");
  await loadApprovals();
});

saveRelayPortButton.addEventListener("click", async () => {
  const port = Number(relayPortInput.value);

  const response = await chrome.runtime.sendMessage({
    type: "set-relay-port",
    port
  }).catch((error) => ({ ok: false, error: String(error) }));

  if (!response?.ok) {
    setText(relayStatusNode, response?.error ?? "Could not save relay port");
    return;
  }

  await Promise.allSettled([loadRelayConfig(), loadRelayStatus()]);
});

saveSitePolicyButton.addEventListener("click", async () => {
  const hostname = siteHostnameInput.value.trim();
  const mode = sitePolicySelect.value;

  if (!hostname) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "set-site-policy",
    hostname,
    mode
  }).catch((error) => ({ ok: false, error: String(error) }));

  if (!response?.ok) {
    setText(relayStatusNode, response?.error ?? "Could not save site policy");
    return;
  }

  await Promise.allSettled([loadSitePolicyState(), loadApprovals()]);
});

createWorkspaceButton.addEventListener("click", async () => {
  if (currentActiveWorkspaceId) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "workspace-create",
    name: buildDefaultSessionName(),
    tabId: Number.isInteger(overrideTabId) ? overrideTabId : undefined,
    targetUrl: overrideTargetUrl ?? undefined
  }).catch((error) => ({ ok: false, error: String(error) }));

  if (!response?.ok) {
    setText(activeWorkspaceNode, response?.error ?? "Workspace creation failed");
    return;
  }

  await Promise.allSettled([loadWorkspaceState(), loadActiveTab()]);
});

focusWorkspaceButton.addEventListener("click", async () => {
  if (!currentActiveWorkspaceId) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "workspace-focus",
    workspaceId: currentActiveWorkspaceId
  }).catch((error) => ({ ok: false, error: String(error) }));

  if (!response?.ok) {
    setText(activeWorkspaceNode, response?.error ?? "Workspace focus failed");
    return;
  }

  await Promise.allSettled([loadWorkspaceState(), loadActiveTab()]);
});

closeWorkspaceButton.addEventListener("click", async () => {
  if (!currentActiveWorkspaceId) {
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "workspace-close",
    workspaceId: currentActiveWorkspaceId,
    closeTabs: true
  }).catch((error) => ({ ok: false, error: String(error) }));

  if (!response?.ok) {
    setText(activeWorkspaceNode, response?.error ?? "Session close failed");
    return;
  }

  await Promise.allSettled([loadWorkspaceState(), loadActiveTab()]);
});

async function ensureRelayStream() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "ensure-relay-stream" });
    if (!response?.ok) {
      setText(relayStatusNode, response?.error ?? "Relay error");
      return;
    }
  } catch {
    setText(relayStatusNode, "Offline");
    setRelayVisualState("offline");
    setActivityVisualState("idle");
  }
}

async function reportPanelPresence(active) {
  await chrome.runtime.sendMessage({
    type: "panel-presence",
    active
  }).catch(() => null);
}

function startPanelHeartbeat() {
  void reportPanelPresence(true);

  if (panelHeartbeatId !== null) {
    window.clearInterval(panelHeartbeatId);
  }

  panelHeartbeatId = window.setInterval(() => {
    void reportPanelPresence(true);
  }, 10_000);
}

async function initializePanel() {
  startPanelHeartbeat();
  await Promise.allSettled([
    loadRelayConfig(),
    loadRelayStatus(),
    loadActiveTab(),
    loadSitePolicyState(),
    loadWorkspaceState(),
    loadApprovals(),
    ensureRelayStream()
  ]);
}

void initializePanel();

window.addEventListener("beforeunload", () => {
  if (panelHeartbeatId !== null) {
    window.clearInterval(panelHeartbeatId);
    panelHeartbeatId = null;
  }

  void reportPanelPresence(false);
});

setRelayVisualState("offline");
setActivityVisualState("idle");

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.relayBusy ||
    changes.relayHealthy ||
    changes.relayCheckedAt ||
    changes.relayPort ||
    changes.relayPairingToken ||
    changes.relayPairingPort
  ) {
    void loadRelayStatus();
  }

  if (changes.pendingApprovals) {
    void loadApprovals();
  }

  if (changes.workspaces || changes.activeWorkspaceId) {
    void Promise.allSettled([loadWorkspaceState(), loadActiveTab()]);
  }

  if (changes.sitePolicies) {
    void Promise.allSettled([loadSitePolicyState(), loadApprovals()]);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "relay-activity") {
    return;
  }

  setActivityVisualState(message.busy ? "working" : "idle");
  void loadRelayStatus();
});
