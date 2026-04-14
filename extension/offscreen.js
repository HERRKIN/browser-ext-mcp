let relayStreamController = null;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let streamConnected = false;

function setConnected(nextConnected) {
  if (streamConnected === nextConnected) {
    return;
  }

  streamConnected = nextConnected;
  void chrome.runtime.sendMessage({
    type: "relay-stream-status",
    connected: nextConnected
  }).catch(() => {});
}

async function getRelayStreamConfig() {
  const response = await chrome.runtime.sendMessage({ type: "get-relay-stream-config" });
  if (!response?.ok) {
    throw new Error(response?.error ?? "Could not load relay stream config.");
  }

  return response.result ?? { enabled: false };
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeRelayStream() {
  clearReconnectTimer();

  if (relayStreamController) {
    relayStreamController.abort();
    relayStreamController = null;
  }

  setConnected(false);
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void connectRelayStream();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
}

function dispatchSseChunk(chunk) {
  const lines = chunk.split(/\r?\n/);
  let eventName = "message";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim() || "message";
    }
  }

  if (eventName === "command") {
    void chrome.runtime.sendMessage({ type: "relay-stream-command-available" }).catch(() => {});
  }
}

async function handleRelayStream(response, controller) {
  if (!response.body) {
    throw new Error("Relay event stream did not include a body.");
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (relayStreamController === controller) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += value;

    let boundaryIndex = buffer.search(/\r?\n\r?\n/);
    while (boundaryIndex >= 0) {
      const chunk = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + (buffer[boundaryIndex] === "\r" ? 4 : 2));

      if (chunk.trim().length > 0) {
        dispatchSseChunk(chunk);
      }

      boundaryIndex = buffer.search(/\r?\n\r?\n/);
    }
  }
}

async function connectRelayStream() {
  closeRelayStream();

  let config;
  try {
    config = await getRelayStreamConfig();
  } catch {
    scheduleReconnect();
    return;
  }

  if (!config?.enabled || typeof config.url !== "string" || config.url.length === 0) {
    scheduleReconnect();
    return;
  }

  const controller = new AbortController();
  relayStreamController = controller;

  try {
    const response = await fetch(config.url, {
      headers: config.headers ?? {},
      signal: controller.signal,
      cache: "no-store"
    });

    if (relayStreamController !== controller) {
      controller.abort();
      return;
    }

    if (response.status === 401) {
      void chrome.runtime.sendMessage({ type: "relay-stream-unauthorized" }).catch(() => {});
      throw new Error("Unauthorized");
    }

    if (!response.ok) {
      throw new Error(`Relay event stream failed with HTTP ${response.status}.`);
    }

    reconnectDelayMs = 1000;
    setConnected(true);
    await handleRelayStream(response, controller);
  } catch (error) {
    if (relayStreamController !== controller) {
      return;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      return;
    }
  }

  if (relayStreamController === controller) {
    relayStreamController = null;
    setConnected(false);
    scheduleReconnect();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "relay-stream-config-changed") {
    return;
  }

  void connectRelayStream();
});

window.addEventListener("beforeunload", () => {
  closeRelayStream();
});

void connectRelayStream();
