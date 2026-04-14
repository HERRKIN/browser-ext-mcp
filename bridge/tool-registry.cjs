const TOOL_META_KEY = "browser-ext-mcp/tool-hints";

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true
};

const MUTATING = {
  openWorldHint: true
};

const IDEMPOTENT_MUTATION = {
  idempotentHint: true,
  openWorldHint: true
};

function entry(title, description, annotations, hints) {
  return {
    title,
    description,
    annotations,
    hints
  };
}

const TOOL_REGISTRY = {
  workspace_create: entry("Create Workspace", "Create an isolated browser workspace backed by a Chrome tab group.", IDEMPOTENT_MUTATION, {
    category: "workspace",
    intent: "Start a contained browser session for agent work without mixing with personal tabs.",
    preferWhen: ["You need a fresh workspace or want to isolate a task from the user's existing tabs."],
    avoidWhen: ["An existing workspace already contains the tabs you need."],
    relatedTools: {
      usuallyAfter: ["workspace_activate", "tab_open"]
    },
    cost: "medium"
  }),
  workspace_list: entry("List Workspaces", "List known browser workspaces and identify the active one.", READ_ONLY, {
    category: "workspace",
    intent: "Discover the current workspace before switching, opening, or closing tabs.",
    preferWhen: ["You need a workspace id or want to inspect the current browser isolation state."],
    cost: "low"
  }),
  workspace_activate: entry("Activate Workspace", "Focus a workspace so subsequent tab tools operate inside it.", MUTATING, {
    category: "workspace",
    intent: "Switch the active workspace before interacting with its tabs.",
    preferWhen: ["The target workspace exists but is not active yet."],
    avoidWhen: ["You already know the active workspace is correct."],
    relatedTools: {
      usuallyBefore: ["tab_open", "tab_focus", "read_all_tabs_in_workspace"]
    },
    cost: "low"
  }),
  workspace_close: entry("Close Workspace", "Close a workspace and optionally its tabs.", {
    destructiveHint: true,
    openWorldHint: true
  }, {
    category: "workspace",
    intent: "Remove a workspace that is no longer needed.",
    preferWhen: ["The task is complete and the workspace should be cleaned up."],
    avoidWhen: ["You still need the tabs or state inside the workspace."],
    cost: "medium"
  }),
  tab_attach_to_workspace: entry("Attach Tab To Workspace", "Move an existing tab into a workspace.", MUTATING, {
    category: "workspace",
    intent: "Bring a tab under workspace control without reopening it.",
    preferWhen: ["The tab already exists and only needs to be attached to the target workspace."],
    relatedTools: {
      alternatives: ["tab_open"]
    },
    cost: "low"
  }),
  tab_open: entry("Open Tab", "Open a URL in a new tab inside the active workspace.", MUTATING, {
    category: "navigation",
    intent: "Create a new tab for a page you want to inspect or interact with.",
    preferWhen: ["You want to preserve the current active tab while opening another page."],
    relatedTools: {
      usuallyAfter: ["screenshot_viewport", "read_page"]
    },
    cost: "medium"
  }),
  tab_focus: entry("Focus Tab", "Focus an existing tab so subsequent tools target it.", MUTATING, {
    category: "navigation",
    intent: "Switch to a known tab before reading or interacting with it.",
    preferWhen: ["You already know the tab id you want to work on."],
    cost: "low"
  }),
  tab_close: entry("Close Tab", "Close an existing tab inside the active workspace.", {
    destructiveHint: true,
    openWorldHint: true
  }, {
    category: "navigation",
    intent: "Remove a tab that is no longer needed.",
    cost: "low"
  }),
  tabs_list: entry("List Tabs", "List the tabs visible to the active workspace with ids, titles, and URLs.", READ_ONLY, {
    category: "navigation",
    intent: "Discover tab ids before focusing, closing, or comparing tabs.",
    preferWhen: ["You need a tab id or want a quick view of the current workspace state."],
    relatedTools: {
      usuallyBefore: ["tab_focus", "tab_close"]
    },
    cost: "low"
  }),
  tab_group_list: entry("List Tab Groups", "List Chrome tab groups currently available in the browser.", READ_ONLY, {
    category: "workspace",
    intent: "Inspect the underlying Chrome grouping state.",
    preferWhen: ["You need to correlate workspaces with existing tab groups."],
    cost: "low"
  }),
  site_policy_list: entry("List Site Policies", "List per-hostname browser policies controlling guarded actions.", READ_ONLY, {
    category: "policy",
    intent: "Inspect whether a hostname is allowed, blocked, or requires approval.",
    cost: "low"
  }),
  site_policy_set: entry("Set Site Policy", "Set the policy for a hostname to allow, ask, or block guarded actions.", IDEMPOTENT_MUTATION, {
    category: "policy",
    intent: "Change the approval policy for a site before navigation or interaction.",
    preferWhen: ["The current site should always be allowed or blocked for this workflow."],
    cost: "low"
  }),
  approval_list: entry("List Approvals", "List pending sensitive browser actions awaiting approval.", READ_ONLY, {
    category: "policy",
    intent: "Inspect queued sensitive actions before approving or denying them.",
    cost: "low"
  }),
  approval_decide: entry("Resolve Approval", "Approve or deny a previously queued sensitive browser action.", MUTATING, {
    category: "policy",
    intent: "Continue or cancel a guarded action after review.",
    preferWhen: ["An action is blocked on approval."],
    relatedTools: {
      usuallyBefore: ["navigate", "click", "type", "upload_file"]
    },
    cost: "low"
  }),
  artifact_list: entry("List Artifacts", "List stored artifacts captured during browser work.", READ_ONLY, {
    category: "artifacts",
    intent: "Inspect what screenshots or reports are already stored.",
    cost: "low"
  }),
  artifact_get: entry("Get Artifact", "Retrieve one stored artifact by id. Returns image content when the artifact includes a saved snapshot.", READ_ONLY, {
    category: "artifacts",
    intent: "Open a previously captured artifact for direct inspection.",
    preferWhen: ["You already have an artifact id and want to inspect its stored payload or image snapshot."],
    relatedTools: {
      usuallyBefore: ["artifact_list"],
      alternatives: ["screenshot_viewport", "screenshot_full_page", "screenshot_element"]
    },
    cost: "low"
  }),
  artifact_clear: entry("Clear Artifacts", "Remove stored artifacts from the current or selected workspace.", {
    destructiveHint: true
  }, {
    category: "artifacts",
    intent: "Clean up previously captured artifacts.",
    cost: "low"
  }),
  read_all_tabs_in_workspace: entry("Read All Tabs In Workspace", "Read every tab in the active workspace and return a page summary for each one.", READ_ONLY, {
    category: "reading",
    intent: "Compare or summarize multiple open tabs at once.",
    preferWhen: ["You need cross-tab triage or a workspace-wide snapshot."],
    avoidWhen: ["You only need the active tab."],
    relatedTools: {
      alternatives: ["read_page", "tabs_list"]
    },
    cost: "high"
  }),
  collect_data_across_tabs: entry("Collect Data Across Tabs", "Collect matching elements across all tabs in a workspace.", READ_ONLY, {
    category: "reading",
    intent: "Find repeated UI affordances or labels across multiple tabs.",
    preferWhen: ["You need a filtered cross-tab scan rather than a full page dump per tab."],
    avoidWhen: ["Only one tab matters."],
    cost: "medium"
  }),
  navigate: entry("Navigate", "Open a URL in the active tab. For quick inspect-only tasks, usually follow with screenshot_viewport instead of DOM inspection tools.", MUTATING, {
    category: "navigation",
    intent: "Load a page in the active tab.",
    preferWhen: ["The task starts from a URL and the current tab can be reused."],
    relatedTools: {
      usuallyAfter: ["screenshot_viewport", "read_page", "wait_for"],
      alternatives: ["tab_open"]
    },
    examples: [
      {
        userGoal: "Check whether a homepage has a visual promo or doodle.",
        minimalSequence: ["navigate", "screenshot_viewport"]
      }
    ],
    cost: "medium"
  }),
  read_page: entry("Read Page", "Get a structured page snapshot with stable refs for downstream interaction tools. Prefer this when you need DOM state, labels, or refs; avoid it for simple visual inspection.", READ_ONLY, {
    category: "reading",
    intent: "Inspect the active page as structured data and generate refs for later actions.",
    preferWhen: [
      "You need stable refs for click, type, hover, screenshot_element, or DOM/CSS inspection.",
      "You need visible text, landmarks, headings, or a machine-readable summary."
    ],
    avoidWhen: [
      "The task is purely visual and a screenshot answers it.",
      "You only need to know whether a page loaded and its appearance is enough."
    ],
    relatedTools: {
      producesRefsFor: [
        "click",
        "type",
        "clear_input",
        "select_option",
        "toggle_checkbox",
        "form_fill",
        "upload_file",
        "hover",
        "screenshot_element",
        "inspect_dom_node",
        "inspect_css_rules"
      ],
      alternatives: ["screenshot_viewport", "get_accessibility_tree"]
    },
    examples: [
      {
        userGoal: "Click a button by label.",
        minimalSequence: ["read_page", "click"]
      }
    ],
    cost: "medium"
  }),
  get_accessibility_tree: entry("Get Accessibility Tree", "Return the accessibility tree for the active page. Use this for semantics and accessibility debugging, not for normal visual inspection.", READ_ONLY, {
    category: "reading",
    intent: "Inspect accessibility roles, names, and document structure.",
    preferWhen: ["The task is accessibility-focused or refs are not enough to explain semantics."],
    avoidWhen: ["A regular page summary or screenshot already answers the question."],
    relatedTools: {
      alternatives: ["read_page"]
    },
    cost: "medium"
  }),
  find_elements: entry("Find Elements", "Find interactive elements by role and label substring.", READ_ONLY, {
    category: "reading",
    intent: "Locate specific interactive targets without reading the full page output.",
    preferWhen: ["You already know the role or label pattern you need."],
    avoidWhen: ["You need a broader page snapshot or stable refs for many elements at once."],
    relatedTools: {
      alternatives: ["read_page"],
      usuallyAfter: ["click", "type", "hover"]
    },
    cost: "low"
  }),
  wait_for: entry("Wait For", "Poll until a ref, selector, visible text, or matching interactive element appears. Use this for asynchronous or delayed UI changes, not as routine verification after every navigation. Account for significant delays between tool calls: many real flows have multi-second gaps, so waits shorter than 5 seconds are often unnecessary or misleading.", READ_ONLY, {
    category: "synchronization",
    intent: "Synchronize with delayed rendering, navigation, network-driven updates, or post-click state changes.",
    preferWhen: [
      "The page updates asynchronously after an action.",
      "The target element or text is expected to appear later."
    ],
    avoidWhen: [
      "The current screenshot or page state already shows the answer.",
      "You are only doing a simple navigation plus screenshot flow."
    ],
    relatedTools: {
      usuallyBefore: ["click", "type", "screenshot_viewport"],
      usuallyAfter: ["navigate", "click", "press_keys"]
    },
    examples: [
      {
        userGoal: "Wait for search results after submitting a form.",
        minimalSequence: ["click", "wait_for", "read_page"]
      }
    ],
    cost: "medium"
  }),
  highlight_elements: entry("Highlight Elements", "Overlay matching interactive elements on the page for visual debugging.", READ_ONLY, {
    category: "debugging",
    intent: "Visually confirm where matching elements are on the current page.",
    preferWhen: ["You need to debug element matching or visually inspect multiple targets."],
    avoidWhen: ["A normal screenshot or direct interaction is enough."],
    relatedTools: {
      usuallyAfter: ["find_elements", "read_page"],
      usuallyBefore: ["clear_highlights"]
    },
    cost: "medium"
  }),
  clear_highlights: entry("Clear Highlights", "Remove previously rendered debug highlights from the page.", IDEMPOTENT_MUTATION, {
    category: "debugging",
    intent: "Restore the page after visual debugging overlays.",
    relatedTools: {
      usuallyAfter: ["highlight_elements"]
    },
    cost: "low"
  }),
  inspect_dom_node: entry("Inspect DOM Node", "Inspect a specific element's DOM details using a stable ref from read_page.", READ_ONLY, {
    category: "debugging",
    intent: "Understand the DOM structure and attributes of a specific target.",
    preferWhen: ["You already have a ref and need node-level debugging."],
    avoidWhen: ["You only need a visual confirmation or a broad page snapshot."],
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["inspect_css_rules", "screenshot_element"]
    },
    cost: "medium"
  }),
  inspect_css_rules: entry("Inspect CSS Rules", "Inspect the computed and matched CSS rules for a specific element ref.", READ_ONLY, {
    category: "debugging",
    intent: "Debug styling, layout, and cascade issues for one element.",
    preferWhen: ["The task is about CSS or visual styling bugs on a known element."],
    avoidWhen: ["A screenshot is sufficient to answer the question."],
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["inspect_dom_node", "screenshot_element"]
    },
    cost: "medium"
  }),
  click: entry("Click", "Click an element referenced by read_page or find_elements.", MUTATING, {
    category: "interaction",
    intent: "Activate a known interactive target.",
    relatedTools: {
      dependsOn: ["read_page", "find_elements"],
      usuallyAfter: ["wait_for"]
    },
    cost: "low"
  }),
  type: entry("Type", "Insert text into an input or textarea referenced by read_page.", MUTATING, {
    category: "interaction",
    intent: "Fill text into a known editable element.",
    relatedTools: {
      dependsOn: ["read_page", "find_elements"],
      usuallyAfter: ["wait_for"]
    },
    cost: "low"
  }),
  clear_input: entry("Clear Input", "Clear the contents of an input or textarea referenced by read_page.", MUTATING, {
    category: "interaction",
    intent: "Reset a known editable field before typing or validating it.",
    relatedTools: {
      dependsOn: ["read_page"],
      usuallyBefore: ["type"]
    },
    cost: "low"
  }),
  select_option: entry("Select Option", "Choose an option in a select element by ref.", MUTATING, {
    category: "interaction",
    intent: "Update a select input with a specific value, label, or index.",
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["form_fill"]
    },
    cost: "low"
  }),
  toggle_checkbox: entry("Toggle Checkbox", "Toggle a checkbox or radio input by ref.", MUTATING, {
    category: "interaction",
    intent: "Update a known binary or radio control.",
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["form_fill"]
    },
    cost: "low"
  }),
  form_fill: entry("Form Fill", "Apply multiple field updates in order using refs from read_page.", MUTATING, {
    category: "interaction",
    intent: "Fill a multi-field form efficiently with one tool call.",
    preferWhen: ["You need to update several fields at once."],
    avoidWhen: ["Only one simple field needs changing."],
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["type", "select_option", "toggle_checkbox"]
    },
    cost: "medium"
  }),
  upload_file: entry("Upload File", "Upload a local file into a file input referenced by read_page.", MUTATING, {
    category: "interaction",
    intent: "Attach a file to a known upload control.",
    relatedTools: {
      dependsOn: ["read_page"]
    },
    cost: "medium"
  }),
  hover: entry("Hover", "Hover a known element by ref.", MUTATING, {
    category: "interaction",
    intent: "Trigger hover states, tooltips, or menus on a known target.",
    relatedTools: {
      dependsOn: ["read_page"],
      usuallyAfter: ["wait_for"]
    },
    cost: "low"
  }),
  press_keys: entry("Press Keys", "Dispatch keyboard keys to the active element or a known ref.", MUTATING, {
    category: "interaction",
    intent: "Drive keyboard-only interactions or shortcuts.",
    preferWhen: ["The workflow depends on keyboard navigation or shortcuts."],
    cost: "low"
  }),
  scroll: entry("Scroll", "Scroll the current page viewport.", MUTATING, {
    category: "interaction",
    intent: "Reveal content that is outside the visible viewport.",
    preferWhen: ["The target is off-screen or you need to inspect more of the page."],
    relatedTools: {
      usuallyAfter: ["screenshot_viewport", "read_page"]
    },
    cost: "low"
  }),
  get_console_logs: entry("Get Console Logs", "Read buffered console logs from the active tab.", READ_ONLY, {
    category: "diagnostics",
    intent: "Inspect runtime logs after reproducing a browser behavior.",
    preferWhen: ["The task is about JS warnings, errors, or console output."],
    avoidWhen: ["You only need page content or visuals."],
    cost: "low"
  }),
  start_network_capture: entry("Start Network Capture", "Begin buffering network requests so you can inspect them later with get_last_requests and stop_network_capture. Use this only when network behavior matters, not for ordinary page reading.", MUTATING, {
    category: "diagnostics",
    intent: "Capture requests around a navigation or interaction whose network side effects matter.",
    preferWhen: ["You need to inspect XHR, fetch, document requests, or debugging around network activity."],
    avoidWhen: ["The task is about static content, layout, or a simple screenshot."],
    relatedTools: {
      usuallyBefore: ["navigate", "click", "press_keys"],
      usuallyAfter: ["get_last_requests", "stop_network_capture"]
    },
    examples: [
      {
        userGoal: "See what request fires when clicking a button.",
        minimalSequence: ["start_network_capture", "click", "get_last_requests", "stop_network_capture"]
      }
    ],
    cost: "medium"
  }),
  stop_network_capture: entry("Stop Network Capture", "Stop the active network capture session.", MUTATING, {
    category: "diagnostics",
    intent: "End request buffering after the interesting action has occurred.",
    relatedTools: {
      dependsOn: ["start_network_capture"],
      usuallyAfter: ["get_last_requests"]
    },
    cost: "low"
  }),
  get_last_requests: entry("Get Last Requests", "Return the most recent captured network requests.", READ_ONLY, {
    category: "diagnostics",
    intent: "Inspect captured network activity after start_network_capture.",
    preferWhen: ["You already captured the interaction and need the request list."],
    relatedTools: {
      dependsOn: ["start_network_capture"],
      usuallyBefore: ["stop_network_capture"]
    },
    cost: "low"
  }),
  get_last_errors: entry("Get Last Errors", "Return recent browser errors captured for the active tab.", READ_ONLY, {
    category: "diagnostics",
    intent: "Inspect runtime failures without reading the entire console log stream.",
    preferWhen: ["You need recent exceptions or page-level errors."],
    relatedTools: {
      alternatives: ["get_console_logs"]
    },
    cost: "low"
  }),
  performance_snapshot: entry("Performance Snapshot", "Capture browser performance metrics for the active page.", READ_ONLY, {
    category: "diagnostics",
    intent: "Inspect performance timing and related metrics.",
    preferWhen: ["The task is about page performance rather than content or layout."],
    avoidWhen: ["You only need visual verification or DOM inspection."],
    cost: "medium"
  }),
  screenshot_full_page: entry("Screenshot Full Page", "Capture a full-page screenshot, including content outside the current viewport.", READ_ONLY, {
    category: "visual",
    intent: "Inspect or export an entire long page in one image.",
    preferWhen: ["You need content beyond the visible fold."],
    avoidWhen: ["The visible viewport is enough to answer the question."],
    relatedTools: {
      alternatives: ["screenshot_viewport"]
    },
    cost: "medium"
  }),
  screenshot_element: entry("Screenshot Element", "Capture a screenshot of one element referenced by read_page.", READ_ONLY, {
    category: "visual",
    intent: "Inspect or export a single known element instead of the whole page.",
    preferWhen: ["You already have a ref and only need that element's visual state."],
    relatedTools: {
      dependsOn: ["read_page"],
      alternatives: ["screenshot_viewport", "screenshot_full_page"]
    },
    cost: "medium"
  }),
  screenshot_with_labels: entry("Screenshot With Labels", "Capture the visible page and overlay stable refs on interactive elements. Use this for debugging refs or mapping DOM handles back to the UI, not for normal screenshots.", READ_ONLY, {
    category: "visual",
    intent: "Debug or explain how interactive refs map onto the visible interface.",
    preferWhen: ["You need to see where refs are on screen before clicking or inspecting elements."],
    avoidWhen: ["A plain screenshot already answers the question."],
    relatedTools: {
      alternatives: ["screenshot_viewport", "highlight_elements"],
      usuallyAfter: ["read_page"]
    },
    cost: "medium"
  }),
  analyze_responsive_breakpoints: entry("Analyze Responsive Breakpoints", "Capture breakpoint snapshots and layout diagnostics across multiple viewport sizes.", READ_ONLY, {
    category: "visual",
    intent: "Inspect responsive behavior across mobile, tablet, and desktop sizes.",
    preferWhen: ["The task is explicitly about responsive design or breakpoint regressions."],
    avoidWhen: ["You only need the current viewport."],
    relatedTools: {
      alternatives: ["screenshot_viewport", "read_page"]
    },
    cost: "high"
  }),
  screenshot_viewport: entry("Screenshot Viewport", "Capture the currently visible viewport. This is the primary tool for quick visual inspection and should be preferred before DOM-reading tools when the task is purely visual.", READ_ONLY, {
    category: "visual",
    intent: "Answer visual questions from the current visible page state with the fewest steps.",
    preferWhen: [
      "The task is visual: check a logo, doodle, hero image, color, layout, or visible content.",
      "You need the shortest inspect-and-answer path after navigation."
    ],
    avoidWhen: [
      "You need stable refs or machine-readable page structure.",
      "You need content outside the visible viewport."
    ],
    relatedTools: {
      alternatives: ["screenshot_full_page", "screenshot_with_labels", "read_page"],
      usuallyAfter: ["navigate", "scroll"]
    },
    examples: [
      {
        userGoal: "Open a homepage and tell me if there is a doodle or promo.",
        minimalSequence: ["navigate", "screenshot_viewport"]
      }
    ],
    cost: "low"
  })
};

function getToolEntry(name) {
  const entryForTool = TOOL_REGISTRY[name];
  if (!entryForTool) {
    throw new Error(`Missing tool registry entry for ${name}.`);
  }

  return entryForTool;
}

function buildToolMeta(name) {
  return {
    [TOOL_META_KEY]: getToolEntry(name).hints
  };
}

function getToolStubDefinitions() {
  return Object.entries(TOOL_REGISTRY).map(([name, config]) => ({
    name,
    title: config.title,
    description: config.description,
    annotations: config.annotations,
    _meta: buildToolMeta(name)
  }));
}

module.exports = {
  TOOL_META_KEY,
  TOOL_REGISTRY,
  buildToolMeta,
  getToolEntry,
  getToolStubDefinitions
};
