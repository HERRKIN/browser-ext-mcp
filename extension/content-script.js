chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "page-command") {
    return false;
  }

  handlePageCommand(message.command)
    .then((result) => sendResponse(result))
    .catch((error) =>
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    );

  return true;
});

function isVisible(element) {
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({
      checkOpacity: false,
      checkVisibilityCSS: true
    });
  }

  const view = element.ownerDocument?.defaultView ?? window;
  const style = view.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function getRole(element) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole) {
    return explicitRole;
  }

  switch (element.tagName.toLowerCase()) {
    case "a":
      return "link";
    case "button":
      return "button";
    case "input":
      return element.getAttribute("type") === "checkbox" ? "checkbox" : "input";
    case "select":
      return "select";
    case "textarea":
      return "textarea";
    default:
      return "generic";
  }
}

let stableRefCounter = 1;
const LABEL_OVERLAY_ID = "browser-ext-mcp-label-overlay";
const HIGHLIGHT_OVERLAY_ID = "browser-ext-mcp-highlight-overlay";
const ACTIVITY_OVERLAY_ID = "browser-ext-mcp-activity-overlay";
const DEFAULT_ACTIVITY_OVERLAY_DURATION_MS = 10_000;
let activityOverlayTimeoutId = null;
let activityOverlayState = null;

function nextStableRef() {
  const ref = `ref_${stableRefCounter}`;
  stableRefCounter += 1;
  return ref;
}

function normalizeText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function getElementText(element) {
  return normalizeText(element.textContent || "");
}

function getElementLabel(element) {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("title") ||
    ("value" in element && typeof element.value === "string" ? normalizeText(element.value) : "") ||
    getElementText(element) ||
    ""
  );
}

function getElementState(element) {
  const state = {
    ref: element.dataset.browserExtMcpRef ?? "",
    role: getRole(element),
    tagName: element.tagName.toLowerCase(),
    label: getElementLabel(element)
  };

  if (element instanceof HTMLInputElement) {
    return {
      ...state,
      inputType: element.type,
      value: element.value,
      checked: element.checked
    };
  }

  if (element instanceof HTMLTextAreaElement) {
    return {
      ...state,
      inputType: "textarea",
      value: element.value
    };
  }

  if (element instanceof HTMLSelectElement) {
    return {
      ...state,
      inputType: "select",
      value: element.value,
      options: Array.from(element.options).map((option, index) => ({
        index,
        value: option.value,
        label: option.label
      }))
    };
  }

  return state;
}

function getElementByRef(ref) {
  return document.querySelector(`[data-browser-ext-mcp-ref="${ref}"]`);
}

function ensureElementRef(element) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Target element is not an HTMLElement.");
  }

  let ref = element.dataset.browserExtMcpRef;
  if (!ref) {
    ref = nextStableRef();
    element.dataset.browserExtMcpRef = ref;
  }

  return ref;
}

function getElementAttributes(element) {
  const attributes = {};

  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }

  return attributes;
}

function buildElementPath(element) {
  const segments = [];
  let current = element;

  while (current instanceof HTMLElement && current !== document.body && segments.length < 6) {
    let segment = current.tagName.toLowerCase();

    if (current.id) {
      segment += `#${current.id}`;
    } else {
      const classList = Array.from(current.classList).slice(0, 2);
      if (classList.length > 0) {
        segment += `.${classList.join(".")}`;
      }

      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((entry) => entry.tagName === current.tagName)
        : [];

      if (siblings.length > 1) {
        segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    segments.unshift(segment);
    current = current.parentElement;
  }

  return segments.join(" > ");
}

function getAbsoluteRect(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round((rect.left + window.scrollX) * 100) / 100,
    y: Math.round((rect.top + window.scrollY) * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    right: Math.round(rect.right * 100) / 100,
    bottom: Math.round(rect.bottom * 100) / 100,
    left: Math.round(rect.left * 100) / 100
  };
}

function pickComputedStyle(style, properties) {
  return properties.reduce((result, property) => {
    result[property] = style.getPropertyValue(property);
    return result;
  }, {});
}

function serializeRuleStyle(style) {
  const declarations = {};

  for (const property of Array.from(style)) {
    declarations[property] = style.getPropertyValue(property);
  }

  return declarations;
}

function collectMatchedCssRules(element, ruleList, matches, context = {}) {
  for (const rule of Array.from(ruleList ?? [])) {
    if (matches.length >= 20) {
      return;
    }

    if (rule instanceof CSSStyleRule) {
      try {
        if (!element.matches(rule.selectorText)) {
          continue;
        }
      } catch {
        continue;
      }

      matches.push({
        selectorText: rule.selectorText,
        media: context.media,
        source: context.source,
        declarations: serializeRuleStyle(rule.style)
      });
      continue;
    }

    if (rule instanceof CSSMediaRule) {
      collectMatchedCssRules(element, rule.cssRules, matches, {
        media: rule.conditionText,
        source: context.source
      });
    }
  }
}

function inspectDomNode(ref) {
  const element = getElementByRef(ref);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element ${ref} was not found.`);
  }

  const rect = getAbsoluteRect(element);
  const attributes = getElementAttributes(element);
  const parent = element.parentElement instanceof HTMLElement
    ? {
        tagName: element.parentElement.tagName.toLowerCase(),
        label: getElementLabel(element.parentElement) || undefined,
        path: buildElementPath(element.parentElement)
      }
    : null;

  return {
    ...getElementState(element),
    path: buildElementPath(element),
    text: element.innerText?.replace(/\s+/g, " ").trim() || undefined,
    visible: isVisible(element),
    disabled: "disabled" in element ? Boolean(element.disabled) : false,
    attributes,
    rect,
    scroll: {
      width: element.scrollWidth,
      height: element.scrollHeight
    },
    client: {
      width: element.clientWidth,
      height: element.clientHeight
    },
    parent
  };
}

function inspectCssRules(ref) {
  const element = getElementByRef(ref);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element ${ref} was not found.`);
  }

  const computedStyle = window.getComputedStyle(element);
  const matchedRules = [];

  for (const styleSheet of Array.from(document.styleSheets)) {
    try {
      collectMatchedCssRules(element, styleSheet.cssRules, matchedRules, {
        source: styleSheet.href || "inline"
      });
    } catch {
      continue;
    }
  }

  return {
    ref,
    path: buildElementPath(element),
    inlineStyle: serializeRuleStyle(element.style),
    computedStyle: pickComputedStyle(computedStyle, [
      "display",
      "position",
      "color",
      "background-color",
      "font-size",
      "font-weight",
      "line-height",
      "width",
      "height",
      "max-width",
      "min-width",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "border-radius",
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "box-shadow",
      "overflow-x",
      "overflow-y",
      "opacity",
      "visibility",
      "z-index"
    ]),
    matchedRules
  };
}

function collectLayoutIssues(command = {}) {
  const viewportWidth =
    typeof command.expectedViewportWidth === "number" ? command.expectedViewportWidth : window.innerWidth;
  const viewportHeight =
    typeof command.expectedViewportHeight === "number" ? command.expectedViewportHeight : window.innerHeight;
  const documentWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body?.scrollWidth ?? 0
  );
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0
  );
  const issues = [];
  const elements = Array.from(document.querySelectorAll("body *")).slice(0, 400);

  for (const element of elements) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      continue;
    }

    let ref = element.dataset.browserExtMcpRef;
    if (!ref) {
      ref = nextStableRef();
      element.dataset.browserExtMcpRef = ref;
    }

    const rect = getAbsoluteRect(element);
    const computedStyle = window.getComputedStyle(element);
    const path = buildElementPath(element);
    const label = getElementLabel(element) || undefined;

    if (rect.right > viewportWidth + 1 || rect.left < -1) {
      issues.push({
        type: "horizontal-overflow",
        ref,
        tagName: element.tagName.toLowerCase(),
        label,
        path,
        rect
      });
    }

    if (
      ["hidden", "clip", "auto", "scroll"].includes(computedStyle.overflowX) &&
      element.scrollWidth > element.clientWidth + 1
    ) {
      issues.push({
        type: "clipped-horizontal-content",
        ref,
        tagName: element.tagName.toLowerCase(),
        label,
        path,
        rect,
        details: {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: computedStyle.overflowX
        }
      });
    }

    if (
      ["hidden", "clip", "auto", "scroll"].includes(computedStyle.overflowY) &&
      element.scrollHeight > element.clientHeight + 1
    ) {
      issues.push({
        type: "clipped-vertical-content",
        ref,
        tagName: element.tagName.toLowerCase(),
        label,
        path,
        rect,
        details: {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowY: computedStyle.overflowY
        }
      });
    }

    if (rect.bottom < 0 || rect.top > viewportHeight + 1) {
      issues.push({
        type: "outside-viewport",
        ref,
        tagName: element.tagName.toLowerCase(),
        label,
        path,
        rect
      });
    }
  }

  const cappedIssues = issues.slice(0, 100);

  return {
    document: {
      viewportWidth,
      viewportHeight,
      documentWidth,
      documentHeight,
      horizontalOverflow:
        documentWidth > viewportWidth + 1 || cappedIssues.some((issue) => issue.type === "horizontal-overflow")
    },
    issues: cappedIssues
  };
}

function setNativeValue(element, value) {
  if (element instanceof HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    return;
  }

  if (element instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(element, value);
  }
}

function setNativeChecked(element, checked) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
  descriptor?.set?.call(element, checked);
}

function setNativeSelectValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  descriptor?.set?.call(element, value);
}

function dispatchInputEvents(element) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function bringElementIntoView(element) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("The target element is not scrollable into view.");
  }

  element.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "instant"
  });
}

function ensureInteractableElement(element, options = {}) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("The target element is not interactable.");
  }

  const { allowReadonly = false } = options;

  if (!isVisible(element)) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not visible.`);
  }

  if ("disabled" in element && element.disabled) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is disabled.`);
  }

  if (!allowReadonly && "readOnly" in element && element.readOnly) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is read-only.`);
  }

  bringElementIntoView(element);
}

function writeTextToElement(element, text) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not a text input.`);
  }

  ensureInteractableElement(element);
  element.focus();
  setNativeValue(element, text);
  dispatchInputEvents(element);
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return getElementState(element);
}

function setCheckedState(element, checked) {
  if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not a checkbox or radio input.`);
  }

  ensureInteractableElement(element);
  element.focus();
  setNativeChecked(element, checked);
  dispatchInputEvents(element);
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return getElementState(element);
}

function toggleCheckboxState(element) {
  if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not a checkbox or radio input.`);
  }

  return setCheckedState(element, !element.checked);
}

function selectElementOption(element, command) {
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not a select.`);
  }

  let option = null;

  if (typeof command.value === "string") {
    option = Array.from(element.options).find((candidate) => candidate.value === command.value) ?? null;
  } else if (typeof command.label === "string") {
    option = Array.from(element.options).find((candidate) => candidate.label === command.label) ?? null;
  } else if (Number.isInteger(command.index)) {
    option = element.options.item(command.index) ?? null;
  }

  if (!option) {
    throw new Error(`No matching option was found for ${element.dataset.browserExtMcpRef ?? "unknown"}.`);
  }

  ensureInteractableElement(element);
  element.focus();
  setNativeSelectValue(element, option.value);
  dispatchInputEvents(element);
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return getElementState(element);
}

function resolveKeyboardTarget(ref) {
  if (typeof ref === "string" && ref.length > 0) {
    const element = getElementByRef(ref);
    if (!(element instanceof HTMLElement)) {
      throw new Error(`Element ${ref} was not found.`);
    }

    element.focus();
    return element;
  }

  if (document.activeElement instanceof HTMLElement) {
    return document.activeElement;
  }

  if (document.body instanceof HTMLElement) {
    document.body.focus();
    return document.body;
  }

  throw new Error("No active element is available to receive keyboard events.");
}

function pressKeysOnElement(element, keys) {
  const dispatched = [];

  for (const key of keys) {
    const eventInit = {
      key,
      bubbles: true,
      cancelable: true
    };

    element.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    element.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    dispatched.push(key);
  }

  return {
    ok: true,
    message: `Pressed ${dispatched.join(", ")}.`,
    data: {
      target: getElementState(element),
      keys: dispatched
    }
  };
}

function decodeBase64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function setFilesOnInput(element, filePayloads) {
  if (!(element instanceof HTMLInputElement) || element.type !== "file") {
    throw new Error(`Element ${element.dataset.browserExtMcpRef ?? "unknown"} is not a file input.`);
  }

  ensureInteractableElement(element);
  const dataTransfer = new DataTransfer();

  for (const filePayload of filePayloads) {
    const file = new File([decodeBase64ToUint8Array(filePayload.base64)], filePayload.name, {
      type: filePayload.mimeType || "application/octet-stream",
      lastModified: Math.round(filePayload.lastModified ?? Date.now())
    });
    dataTransfer.items.add(file);
  }

  element.focus();
  element.files = dataTransfer.files;
  dispatchInputEvents(element);
  element.dispatchEvent(new Event("blur", { bubbles: true }));

  return {
    ...getElementState(element),
    files: Array.from(element.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type
    }))
  };
}

function hoverElement(element) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("The target element is not hoverable.");
  }

  ensureInteractableElement(element, { allowReadonly: true });
  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };

  element.dispatchEvent(new MouseEvent("pointerover", init));
  element.dispatchEvent(new MouseEvent("mouseover", init));
  element.dispatchEvent(new MouseEvent("pointerenter", init));
  element.dispatchEvent(new MouseEvent("mouseenter", init));

  return {
    ok: true,
    message: `Hovered ${element.dataset.browserExtMcpRef ?? "unknown"}.`,
    data: getElementState(element)
  };
}

function clickElement(element) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("The target element is not clickable.");
  }

  ensureInteractableElement(element, { allowReadonly: true });
  element.focus();

  const rect = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2)
  };

  element.dispatchEvent(new PointerEvent("pointerdown", init));
  element.dispatchEvent(new MouseEvent("mousedown", init));
  element.dispatchEvent(new PointerEvent("pointerup", init));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.click();

  return {
    ...getElementState(element),
    clicked: true
  };
}

function collectInteractiveElements(mode) {
  const interactiveSelector = "a, button, input, select, textarea, [role], [tabindex]";
  const selector = mode === "all" ? "body *" : interactiveSelector;
  const elements = Array.from(document.querySelectorAll(selector)).slice(0, 250);
  const interactiveElements = [];

  for (const element of elements) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      continue;
    }

    let ref = element.dataset.browserExtMcpRef;
    if (!ref) {
      ref = nextStableRef();
      element.dataset.browserExtMcpRef = ref;
    }

    interactiveElements.push(getElementState(element));
  }

  return interactiveElements;
}

function removeLabelOverlay() {
  document.getElementById(LABEL_OVERLAY_ID)?.remove();
}

function removeHighlightOverlay() {
  document.getElementById(HIGHLIGHT_OVERLAY_ID)?.remove();
}

function normalizeActivityOverlayLabel(command = {}) {
  return typeof command.label === "string" && command.label.trim() ? command.label.trim() : "Codex is working";
}

function normalizeActivityOverlayDurationMs(command = {}) {
  return typeof command.durationMs === "number" && Number.isFinite(command.durationMs) && command.durationMs > 0
    ? command.durationMs
    : DEFAULT_ACTIVITY_OVERLAY_DURATION_MS;
}

function removeActivityOverlay({ preserveState = false } = {}) {
  if (activityOverlayTimeoutId !== null) {
    window.clearTimeout(activityOverlayTimeoutId);
    activityOverlayTimeoutId = null;
  }
  document.getElementById(ACTIVITY_OVERLAY_ID)?.remove();
  if (!preserveState) {
    activityOverlayState = null;
  }
}

function suspendActivityOverlay() {
  const overlay = document.getElementById(ACTIVITY_OVERLAY_ID);
  if (!overlay || !activityOverlayState) {
    return {
      visible: false
    };
  }

  const remainingMs = activityOverlayState.expiresAt - Date.now();
  if (remainingMs <= 0) {
    removeActivityOverlay();
    return {
      visible: false
    };
  }
  const snapshot = {
    visible: true,
    label: activityOverlayState.label,
    durationMs: remainingMs
  };
  removeActivityOverlay();
  return snapshot;
}

function restoreActivityOverlay(command = {}) {
  if (command.visible !== true) {
    return {
      visible: false,
      restored: false
    };
  }

  return {
    ...showActivityOverlay(command),
    restored: true
  };
}

function showActivityOverlay(command = {}) {
  removeActivityOverlay();

  const label = normalizeActivityOverlayLabel(command);
  const durationMs = normalizeActivityOverlayDurationMs(command);
  activityOverlayState = {
    label,
    durationMs,
    expiresAt: Date.now() + durationMs
  };

  const overlay = document.createElement("div");
  overlay.id = ACTIVITY_OVERLAY_ID;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483645";

  const frame = document.createElement("div");
  frame.style.position = "absolute";
  frame.style.inset = "0";
  frame.style.borderRadius = "0";
  frame.style.overflow = "hidden";
  frame.style.boxSizing = "border-box";

  const halo = document.createElement("div");
  halo.style.position = "absolute";
  halo.style.inset = "0";
  halo.style.borderRadius = "inherit";
  halo.style.background = [
    "linear-gradient(180deg, rgba(21, 126, 251, 0.98) 0%, rgba(21, 126, 251, 0.64) 28%, rgba(21, 126, 251, 0.18) 62%, rgba(21, 126, 251, 0) 100%) top / 100% 18px no-repeat",
    "linear-gradient(0deg, rgba(21, 126, 251, 0.98) 0%, rgba(21, 126, 251, 0.64) 28%, rgba(21, 126, 251, 0.18) 62%, rgba(21, 126, 251, 0) 100%) bottom / 100% 18px no-repeat",
    "linear-gradient(90deg, rgba(21, 126, 251, 0.98) 0%, rgba(21, 126, 251, 0.64) 28%, rgba(21, 126, 251, 0.18) 62%, rgba(21, 126, 251, 0) 100%) left / 18px 100% no-repeat",
    "linear-gradient(270deg, rgba(21, 126, 251, 0.98) 0%, rgba(21, 126, 251, 0.64) 28%, rgba(21, 126, 251, 0.18) 62%, rgba(21, 126, 251, 0) 100%) right / 18px 100% no-repeat"
  ].join(", ");
  halo.style.filter = "drop-shadow(0 0 12px rgba(21, 126, 251, 0.24))";
  halo.style.transformOrigin = "center center";

  const edgeStroke = document.createElement("div");
  edgeStroke.style.position = "absolute";
  edgeStroke.style.inset = "0";
  edgeStroke.style.borderRadius = "inherit";
  edgeStroke.style.boxShadow = [
    "inset 0 0 0 1px rgba(135, 206, 255, 0.72)",
    "inset 0 0 0 2px rgba(21, 126, 251, 0.18)"
  ].join(", ");
  edgeStroke.style.opacity = "0.95";

  const innerWash = document.createElement("div");
  innerWash.style.position = "absolute";
  innerWash.style.inset = "0";
  innerWash.style.borderRadius = "inherit";
  innerWash.style.opacity = "0.46";
  innerWash.style.background = [
    "linear-gradient(180deg, rgba(21, 126, 251, 0.12), rgba(21, 126, 251, 0.05) 34%, rgba(21, 126, 251, 0) 76%)",
    "linear-gradient(90deg, rgba(21, 126, 251, 0.08), rgba(21, 126, 251, 0) 26%, rgba(21, 126, 251, 0) 74%, rgba(21, 126, 251, 0.08))"
  ].join(", ");
  innerWash.style.boxShadow = [
    "inset 0 0 26px rgba(21, 126, 251, 0.1)",
    "inset 0 0 84px rgba(21, 126, 251, 0.04)"
  ].join(", ");

  const badge = document.createElement("div");
  badge.textContent = label;
  badge.style.position = "absolute";
  badge.style.top = "16px";
  badge.style.right = "16px";
  badge.style.padding = "8px 12px";
  badge.style.borderRadius = "999px";
  badge.style.background = "rgba(10, 18, 34, 0.88)";
  badge.style.border = "1px solid rgba(24, 119, 242, 0.55)";
  badge.style.color = "#e8f1ff";
  badge.style.font = "600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace";
  badge.style.letterSpacing = "0.02em";
  badge.style.boxShadow = "0 10px 30px rgba(24, 119, 242, 0.28)";
  badge.style.backdropFilter = "blur(8px)";

  halo.animate(
    [
      {
        opacity: 0.88,
        filter: "drop-shadow(0 0 10px rgba(21, 126, 251, 0.22))"
      },
      {
        opacity: 1,
        filter: "drop-shadow(0 0 16px rgba(21, 126, 251, 0.32))"
      },
      {
        opacity: 0.88,
        filter: "drop-shadow(0 0 10px rgba(21, 126, 251, 0.22))"
      }
    ],
    {
      duration: 1450,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out"
    }
  );

  innerWash.animate(
    [
      {
        opacity: 0.42,
        boxShadow: [
          "inset 0 0 24px rgba(21, 126, 251, 0.08)",
          "inset 0 0 72px rgba(21, 126, 251, 0.03)"
        ].join(", ")
      },
      {
        opacity: 0.82,
        boxShadow: [
          "inset 0 0 44px rgba(21, 126, 251, 0.16)",
          "inset 0 0 120px rgba(21, 126, 251, 0.07)"
        ].join(", ")
      },
      {
        opacity: 0.42,
        boxShadow: [
          "inset 0 0 24px rgba(21, 126, 251, 0.08)",
          "inset 0 0 72px rgba(21, 126, 251, 0.03)"
        ].join(", ")
      }
    ],
    {
      duration: 1450,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out"
    }
  );

  edgeStroke.animate(
    [
      {
        opacity: 0.74
      },
      {
        opacity: 1
      },
      {
        opacity: 0.74
      }
    ],
    {
      duration: 1450,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out"
    }
  );

  badge.animate(
    [
      { transform: "translateY(0px)", opacity: 0.9 },
      { transform: "translateY(-1px)", opacity: 1 },
      { transform: "translateY(0px)", opacity: 0.9 }
    ],
    {
      duration: 1400,
      iterations: Number.POSITIVE_INFINITY,
      easing: "ease-in-out"
    }
  );

  frame.append(halo, edgeStroke, innerWash);
  overlay.append(frame, badge);
  document.documentElement.append(overlay);

  activityOverlayTimeoutId = window.setTimeout(() => {
    activityOverlayTimeoutId = null;
    activityOverlayState = null;
    removeActivityOverlay();
  }, durationMs);

  return {
    visible: true,
    label: badge.textContent,
    durationMs
  };
}

function showLabelOverlay() {
  removeLabelOverlay();

  const interactiveElements = collectInteractiveElements("interactive");
  const overlay = document.createElement("div");
  overlay.id = LABEL_OVERLAY_ID;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = `${Math.max(document.documentElement.scrollWidth, window.innerWidth)}px`;
  overlay.style.height = `${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`;
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483647";

  for (const entry of interactiveElements.slice(0, 50)) {
    const element = getElementByRef(entry.ref);
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const rect = getAbsoluteRect(element);
    const badge = document.createElement("div");
    badge.textContent = `${entry.ref} · ${entry.label || entry.role}`;
    badge.style.position = "absolute";
    badge.style.left = `${Math.max(0, rect.x)}px`;
    badge.style.top = `${Math.max(0, rect.y - 20)}px`;
    badge.style.maxWidth = "260px";
    badge.style.padding = "3px 6px";
    badge.style.borderRadius = "999px";
    badge.style.background = "rgba(24, 119, 242, 0.92)";
    badge.style.color = "#fff";
    badge.style.font = "11px/1.2 monospace";
    badge.style.whiteSpace = "nowrap";
    badge.style.overflow = "hidden";
    badge.style.textOverflow = "ellipsis";
    badge.style.boxShadow = "0 4px 14px rgba(24, 119, 242, 0.35)";

    const outline = document.createElement("div");
    outline.style.position = "absolute";
    outline.style.left = `${Math.max(0, rect.x)}px`;
    outline.style.top = `${Math.max(0, rect.y)}px`;
    outline.style.width = `${Math.max(1, rect.width)}px`;
    outline.style.height = `${Math.max(1, rect.height)}px`;
    outline.style.border = "2px solid rgba(24, 119, 242, 0.92)";
    outline.style.borderRadius = "8px";
    outline.style.boxSizing = "border-box";
    outline.style.background = "rgba(24, 119, 242, 0.08)";

    overlay.append(outline, badge);
  }

  document.body.append(overlay);
  return interactiveElements.length;
}

function showHighlightOverlay(command) {
  removeHighlightOverlay();

  const roleQuery = typeof command.role === "string" ? command.role.trim().toLowerCase() : "";
  const labelQuery =
    typeof command.labelContains === "string" ? command.labelContains.trim().toLowerCase() : "";
  const matches = collectInteractiveElements("interactive").filter((element) => {
    const roleMatches = roleQuery ? element.role.toLowerCase() === roleQuery : true;
    const labelMatches = labelQuery ? element.label.toLowerCase().includes(labelQuery) : true;
    return roleMatches && labelMatches;
  });

  const overlay = document.createElement("div");
  overlay.id = HIGHLIGHT_OVERLAY_ID;
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = `${Math.max(document.documentElement.scrollWidth, window.innerWidth)}px`;
  overlay.style.height = `${Math.max(document.documentElement.scrollHeight, window.innerHeight)}px`;
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483646";

  for (const entry of matches.slice(0, 50)) {
    const element = getElementByRef(entry.ref);
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    const rect = getAbsoluteRect(element);
    const outline = document.createElement("div");
    outline.style.position = "absolute";
    outline.style.left = `${Math.max(0, rect.x)}px`;
    outline.style.top = `${Math.max(0, rect.y)}px`;
    outline.style.width = `${Math.max(1, rect.width)}px`;
    outline.style.height = `${Math.max(1, rect.height)}px`;
    outline.style.border = "3px solid rgba(16, 185, 129, 0.95)";
    outline.style.borderRadius = "10px";
    outline.style.background = "rgba(16, 185, 129, 0.12)";
    outline.style.boxSizing = "border-box";
    overlay.append(outline);
  }

  document.body.append(overlay);

  return {
    count: matches.length,
    elements: matches
  };
}

function collectHeadings() {
  return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((element) => element instanceof HTMLElement && isVisible(element))
    .slice(0, 50)
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: getElementText(element)
    }))
    .filter((heading) => heading.text.length > 0);
}

function getLandmarkRole(element) {
  const explicitRole = element.getAttribute("role");
  if (explicitRole && ["banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region"].includes(explicitRole)) {
    return explicitRole;
  }

  switch (element.tagName.toLowerCase()) {
    case "header":
      return "banner";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "footer":
      return "contentinfo";
    case "aside":
      return "complementary";
    case "form":
      return "form";
    case "section":
      return element.getAttribute("aria-label") ? "region" : null;
    default:
      return null;
  }
}

function collectLandmarks() {
  const selectors = [
    "header",
    "nav",
    "main",
    "footer",
    "aside",
    "form",
    "section[aria-label]",
    '[role="banner"]',
    '[role="navigation"]',
    '[role="main"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    '[role="search"]',
    '[role="form"]',
    '[role="region"]'
  ].join(", ");
  return Array.from(document.querySelectorAll(selectors))
    .filter((element) => element instanceof HTMLElement && isVisible(element))
    .slice(0, 50)
    .map((element) => {
      const role = getLandmarkRole(element);
      if (!role) {
        return null;
      }

      return {
        role,
        tagName: element.tagName.toLowerCase(),
        label: getElementLabel(element)
      };
    })
    .filter((landmark) => landmark !== null);
}

function getAccessibleName(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labels = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((label) => label instanceof HTMLElement)
      .map((label) => label.innerText.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (labels.length > 0) {
      return labels.join(" ");
    }
  }

  return getElementLabel(element);
}

function getAccessibleRole(element) {
  const landmarkRole = getLandmarkRole(element);
  if (landmarkRole) {
    return landmarkRole;
  }

  if (/^H[1-6]$/.test(element.tagName)) {
    return "heading";
  }

  return getRole(element);
}

function shouldIncludeAccessibleNode(element, role, name) {
  if (!isVisible(element)) {
    return false;
  }

  if (role !== "generic") {
    return true;
  }

  return Boolean(name);
}

function buildAccessibilityNode(element, depth) {
  const role = getAccessibleRole(element);
  const name = getAccessibleName(element);

  if (!shouldIncludeAccessibleNode(element, role, name)) {
    return null;
  }

  let ref = element.dataset.browserExtMcpRef;
  if (!ref && ["button", "link", "input", "select", "textarea", "checkbox"].includes(role)) {
    ref = nextStableRef();
    element.dataset.browserExtMcpRef = ref;
  }

  const children = [];
  for (const child of Array.from(element.children).slice(0, 20)) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }

    const childNode = buildAccessibilityNode(child, depth + 1);
    if (childNode) {
      children.push(childNode);
    }
  }

  return {
    role,
    name: name || undefined,
    tagName: element.tagName.toLowerCase(),
    ref: ref || undefined,
    level: role === "heading" ? Number(element.tagName.slice(1)) : undefined,
    depth,
    children
  };
}

function collectAccessibilityTree() {
  const children = [];

  if (document.body instanceof HTMLElement) {
    for (const child of Array.from(document.body.children).slice(0, 25)) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }

      const childNode = buildAccessibilityNode(child, 1);
      if (childNode) {
        children.push(childNode);
      }
    }
  }

  children.push(...buildFrameAccessibilityNodes());

  return {
    role: "document",
    name: document.title || undefined,
    tagName: "body",
    depth: 0,
    children
  };
}

function buildDomSnapshotNode(element, depth) {
  const text = element.innerText?.replace(/\s+/g, " ").trim() ?? "";
  const label = getElementLabel(element);
  const role = getRole(element);

  return {
    depth,
    tagName: element.tagName.toLowerCase(),
    role: role === "generic" ? undefined : role,
    label: label || undefined,
    text: text ? text.slice(0, 120) : undefined
  };
}

function collectDomSnapshot() {
  const selectors = [
    "main",
    "nav",
    "section",
    "form",
    "header",
    "footer",
    "aside",
    "h1, h2, h3",
    "label",
    "output",
    "button",
    "input",
    "select",
    "textarea"
  ].join(", ");

  const nodes = [];
  const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 120);

  for (const element of elements) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      continue;
    }

    let depth = 0;
    let current = element.parentElement;
    while (current && current !== document.body && depth < 8) {
      depth += 1;
      current = current.parentElement;
    }

    nodes.push(buildDomSnapshotNode(element, depth));
  }

  return nodes;
}

function collectDocumentHeadings(doc) {
  return Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((element) => element instanceof HTMLElement)
    .slice(0, 20)
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: (element.innerText || element.textContent || "").trim()
    }))
    .filter((heading) => heading.text.length > 0);
}

function collectDocumentInteractiveSummary(doc) {
  const elements = Array.from(doc.querySelectorAll("a, button, input, select, textarea, [role], [tabindex]")).slice(
    0,
    40
  );

  return elements
    .filter((element) => element instanceof HTMLElement)
    .map((element) => ({
      role: getRole(element),
      tagName: element.tagName.toLowerCase(),
      label: getElementLabel(element)
    }));
}

function collectFrameSummaries(mode) {
  const frames = [];
  const includeFrameDetails = mode === "all";

  for (const frameElement of Array.from(document.querySelectorAll("iframe, frame")).slice(0, 10)) {
    if (!(frameElement instanceof HTMLIFrameElement || frameElement instanceof HTMLFrameElement)) {
      continue;
    }

    const summary = {
      tagName: frameElement.tagName.toLowerCase(),
      title: frameElement.title || "",
      name: frameElement.name || "",
      src: frameElement.src || "",
      sameOrigin: false
    };

    try {
      const frameDoc = frameElement.contentDocument;
      const frameWindow = frameElement.contentWindow;
      if (!frameDoc || !frameWindow) {
        frames.push(summary);
        continue;
      }

      const headings = includeFrameDetails ? collectDocumentHeadings(frameDoc) : [];
      const interactiveElements = includeFrameDetails ? collectDocumentInteractiveSummary(frameDoc) : [];

      frames.push({
        ...summary,
        sameOrigin: true,
        url: frameWindow.location.href,
        documentTitle: frameDoc.title || "",
        viewport: includeFrameDetails
          ? {
              width: frameWindow.innerWidth,
              height: frameWindow.innerHeight
            }
          : undefined,
        headingCount: headings.length,
        interactiveCount: interactiveElements.length,
        headings: includeFrameDetails ? headings : undefined,
        interactiveElements: includeFrameDetails ? interactiveElements : undefined
      });
    } catch {
      frames.push({
        ...summary,
        error: "cross-origin"
      });
    }
  }

  return frames;
}

function buildFrameAccessibilityNodes() {
  return collectFrameSummaries("all").map((frame, index) => ({
    role: "document",
    name: frame.documentTitle || frame.title || frame.name || `Frame ${index + 1}`,
    tagName: frame.tagName,
    depth: 1,
    sameOrigin: frame.sameOrigin,
    url: frame.url || frame.src,
    children: Array.isArray(frame.headings)
      ? frame.headings.map((heading) => ({
          role: "heading",
          name: heading.text,
          level: heading.level,
          tagName: `h${heading.level}`,
          depth: 2,
          children: []
        }))
      : []
  }));
}

function findElements(command) {
  const roleQuery = typeof command.role === "string" ? command.role.trim().toLowerCase() : "";
  const labelQuery =
    typeof command.labelContains === "string" ? command.labelContains.trim().toLowerCase() : "";

  return collectInteractiveElements("interactive").filter((element) => {
    const roleMatches = roleQuery ? element.role.toLowerCase() === roleQuery : true;
    const labelMatches = labelQuery ? element.label.toLowerCase().includes(labelQuery) : true;
    return roleMatches && labelMatches;
  });
}

function findFirstMatchingInteractiveElement(command) {
  const roleQuery = typeof command.role === "string" ? command.role.trim().toLowerCase() : "";
  const labelQuery =
    typeof command.labelContains === "string" ? command.labelContains.trim().toLowerCase() : "";

  for (const element of Array.from(document.querySelectorAll("a, button, input, select, textarea, [role], [tabindex]")).slice(0, 250)) {
    if (!(element instanceof HTMLElement) || !isVisible(element)) {
      continue;
    }

    const role = getRole(element).toLowerCase();
    if (roleQuery && role !== roleQuery) {
      continue;
    }

    const label = getElementLabel(element);
    if (labelQuery && !label.toLowerCase().includes(labelQuery)) {
      continue;
    }

    ensureElementRef(element);
    return getElementState(element);
  }

  return null;
}

function findVisibleElementByText(textContains) {
  const query = typeof textContains === "string" ? textContains.trim().toLowerCase() : "";
  if (!query) {
    return null;
  }

  const selectors = [
    "a",
    "button",
    "input",
    "output",
    "select",
    "textarea",
    "label",
    "p",
    "span",
    "div",
    "li",
    "td",
    "th",
    "h1, h2, h3, h4, h5, h6"
  ].join(", ");
  const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 600);
  return (
    elements.find((entry) => {
      if (!(entry instanceof HTMLElement) || !isVisible(entry)) {
        return false;
      }

      const text = getElementText(entry).toLowerCase();
      return text.includes(query);
    }) ?? null
  );
}

async function waitForMatch(command) {
  const timeoutMs = Number(command.timeoutMs ?? 5000);
  const pollIntervalMs = Math.max(25, Number(command.pollIntervalMs ?? 100));
  const deadline = Date.now() + timeoutMs;
  let lastObservation = { matched: false };

  while (Date.now() <= deadline) {
    lastObservation = findWaitMatch(command);
    if (lastObservation?.matched) {
      return {
        ...lastObservation,
        waitedMs: Math.max(0, timeoutMs - Math.max(0, deadline - Date.now()))
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
  }

  return {
    ...lastObservation,
    waitedMs: timeoutMs
  };
}

function findWaitMatch(command) {
  if (typeof command.ref === "string" && command.ref.length > 0) {
    const element = getElementByRef(command.ref);
    if (element instanceof HTMLElement && isVisible(element)) {
      ensureElementRef(element);
      return {
        matched: true,
        strategy: "ref",
        element: {
          ...getElementState(element),
          text: element.innerText?.replace(/\s+/g, " ").trim() || undefined
        }
      };
    }
  }

  if (typeof command.selector === "string" && command.selector.length > 0) {
    const element = document.querySelector(command.selector);
    if (element instanceof HTMLElement && isVisible(element)) {
      ensureElementRef(element);
      return {
        matched: true,
        strategy: "selector",
        element: {
          ...getElementState(element),
          text: element.innerText?.replace(/\s+/g, " ").trim() || undefined
        }
      };
    }
  }

  if (typeof command.role === "string" || typeof command.labelContains === "string") {
    const match = findFirstMatchingInteractiveElement(command);
    if (match) {
      return {
        matched: true,
        strategy: "interactive-match",
        element: match
      };
    }
  }

  if (typeof command.textContains === "string" && command.textContains.length > 0) {
    const element = findVisibleElementByText(command.textContains);
    if (element instanceof HTMLElement) {
      ensureElementRef(element);
      return {
        matched: true,
        strategy: "text",
        element: {
          ...getElementState(element),
          text: element.innerText?.replace(/\s+/g, " ").trim() || undefined
        }
      };
    }
  }

  return {
    matched: false
  };
}

async function handlePageCommand(command) {
  switch (command.type) {
    case "read_page":
      return {
        ok: true,
        message: "Page read complete.",
        data: {
          url: location.href,
          title: document.title,
          scroll: {
            x: window.scrollX,
            y: window.scrollY
          },
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight
          },
          landmarks: collectLandmarks(),
          headings: collectHeadings(),
          frames: collectFrameSummaries(command.mode ?? "interactive"),
          interactiveElements: collectInteractiveElements(command.mode ?? "interactive"),
          domSnapshot: command.mode === "all" ? collectDomSnapshot() : undefined
        }
      };
    case "find_elements":
      return {
        ok: true,
        message: "Element search complete.",
        data: findElements(command)
      };
    case "wait_for_check":
      return {
        ok: true,
        message: "Wait condition evaluated.",
        data: findWaitMatch(command)
      };
    case "wait_for":
      return {
        ok: true,
        message: "Wait condition evaluated.",
        data: await waitForMatch(command)
      };
    case "get_accessibility_tree":
      return {
        ok: true,
        message: "Accessibility tree captured.",
        data: collectAccessibilityTree()
      };
    case "inspect_dom_node":
      return {
        ok: true,
        message: "DOM node inspection complete.",
        data: inspectDomNode(command.ref)
      };
    case "inspect_css_rules":
      return {
        ok: true,
        message: "CSS inspection complete.",
        data: inspectCssRules(command.ref)
      };
    case "inspect_layout_issues":
      return {
        ok: true,
        message: "Layout inspection complete.",
        data: collectLayoutIssues(command)
      };
    case "show_debug_labels":
      return {
        ok: true,
        message: "Debug labels rendered.",
        data: {
          labeledCount: showLabelOverlay()
        }
      };
    case "hide_debug_labels":
      removeLabelOverlay();
      return {
        ok: true,
        message: "Debug labels removed."
      };
    case "highlight_elements":
      return {
        ok: true,
        message: "Elements highlighted.",
        data: showHighlightOverlay(command)
      };
    case "show_activity_overlay":
      return {
        ok: true,
        message: "Activity overlay shown.",
        data: showActivityOverlay(command)
      };
    case "suspend_activity_overlay":
      return {
        ok: true,
        message: "Activity overlay suspended.",
        data: suspendActivityOverlay()
      };
    case "restore_activity_overlay":
      return {
        ok: true,
        message: "Activity overlay restored.",
        data: restoreActivityOverlay(command)
      };
    case "clear_activity_overlay":
      removeActivityOverlay();
      return {
        ok: true,
        message: "Activity overlay removed."
      };
    case "clear_highlights":
      removeHighlightOverlay();
      return {
        ok: true,
        message: "Highlights removed."
      };
    case "click": {
      const element = document.querySelector(`[data-browser-ext-mcp-ref="${command.ref}"]`);
      if (!(element instanceof HTMLElement)) {
        return { ok: false, message: `Element ${command.ref} was not found.` };
      }

      return { ok: true, message: `Clicked ${command.ref}.`, data: clickElement(element) };
    }
    case "type": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return { ok: false, message: `Element ${command.ref} is not a text input.` };
      }

      return {
        ok: true,
        message: `Typed into ${command.ref}.`,
        data: writeTextToElement(element, command.text)
      };
    }
    case "clear_input": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        return { ok: false, message: `Element ${command.ref} is not a text input.` };
      }

      return {
        ok: true,
        message: `Cleared ${command.ref}.`,
        data: writeTextToElement(element, "")
      };
    }
    case "select_option": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLSelectElement)) {
        return { ok: false, message: `Element ${command.ref} is not a select.` };
      }

      return {
        ok: true,
        message: `Selected an option in ${command.ref}.`,
        data: selectElementOption(element, command)
      };
    }
    case "toggle_checkbox": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLInputElement)) {
        return { ok: false, message: `Element ${command.ref} is not an input.` };
      }

      return {
        ok: true,
        message: `Toggled ${command.ref}.`,
        data: toggleCheckboxState(element)
      };
    }
    case "form_fill": {
      const results = [];

      for (const field of command.fields ?? []) {
        const element = getElementByRef(field.ref);
        if (!(element instanceof HTMLElement)) {
          return { ok: false, message: `Element ${field.ref} was not found.` };
        }

        if (typeof field.text === "string") {
          results.push(writeTextToElement(element, field.clearFirst ? "" : field.text));
          if (field.clearFirst) {
            results.push(writeTextToElement(element, field.text));
          }
          continue;
        }

        if (typeof field.checked === "boolean") {
          results.push(setCheckedState(element, field.checked));
          continue;
        }

        if (
          typeof field.value === "string" ||
          typeof field.label === "string" ||
          Number.isInteger(field.index)
        ) {
          results.push(selectElementOption(element, field));
          continue;
        }

        return { ok: false, message: `Field ${field.ref} did not include a supported fill instruction.` };
      }

      return {
        ok: true,
        message: `Filled ${results.length} field(s).`,
        data: results
      };
    }
    case "upload_file": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLInputElement)) {
        return { ok: false, message: `Element ${command.ref} was not found.` };
      }

      return {
        ok: true,
        message: `Uploaded file(s) into ${command.ref}.`,
        data: setFilesOnInput(element, [command.file].filter(Boolean))
      };
    }
    case "press_keys": {
      const target = resolveKeyboardTarget(command.ref);
      return pressKeysOnElement(target, command.keys ?? []);
    }
    case "hover": {
      const element = getElementByRef(command.ref);
      if (!(element instanceof HTMLElement)) {
        return { ok: false, message: `Element ${command.ref} was not found.` };
      }

      return hoverElement(element);
    }
    case "scroll": {
      window.scrollBy({
        left: Number(command.x ?? 0),
        top: Number(command.y ?? 0),
        behavior: command.behavior ?? "auto"
      });

      return {
        ok: true,
        message: "Scroll complete.",
        data: {
          x: window.scrollX,
          y: window.scrollY
        }
      };
    }
    default:
      return { ok: false, message: `Unsupported page command: ${command.type}` };
  }
}
