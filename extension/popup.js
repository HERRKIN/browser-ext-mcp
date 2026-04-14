const openTabButton = document.getElementById("open-tab");
const statusNode = document.getElementById("status");

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

function buildControlCenterUrl(targetUrl) {
  const baseUrl = chrome.runtime.getURL("sidepanel.html");
  if (!targetUrl) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  url.searchParams.set("targetUrl", targetUrl);
  return url.toString();
}

openTabButton.addEventListener("click", async () => {
  try {
    const tab = await getCurrentTab();
    const controlCenterUrl = buildControlCenterUrl(tab?.url);
    await chrome.tabs.create({
      url: controlCenterUrl
    });
    statusNode.textContent = "Control center opened in a new tab.";
    window.close();
  } catch (error) {
    statusNode.textContent = error instanceof Error ? error.message : String(error);
  }
});
