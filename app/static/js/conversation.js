// Conversation Viewer JavaScript
// This file contains all the client-side logic for the conversation detail page

let SESSION_DATA = null;
let currentFilter = "all";
let filterQuery = "";
let hideIntermediateSteps = true;
let highlightedId = null;
let tokenData = [];
let maxTokens = { input: 1, output: 1, cache: 1 };
let currentMessageIndex = 0;
let urlSearchQuery = ""; // Search query from URL (for highlighting)
let sidebarNavigationLock = null;
let selectedAgentId = "main";
const openSubagentPanelIds = new Set();
const expandedToolResults = new Set();
let alignmentFrame = null;
let streamHeightFrame = null;
let sidebarAgentFilterScrollLeft = 0;
let isSyncingAgentScroll = false;
let suppressMainPanelSyncUntil = 0;
let layoutResizeListenerBound = false;
let subagentPanelRackWidthOverride = null;
let subagentSeparatorResizeState = null;
const SUBAGENT_PANEL_RACK_WIDTH_KEY = "subagentPanelRackWidth";
const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

// Configure marked for GitHub Flavored Markdown
marked.setOptions({
  breaks: false,
  gfm: true,
});

// Get search query from URL parameters
function getUrlSearchQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}

// Theme — toggleTheme() is provided by base.js; override it here to also
// re-render the sparkline when the colour scheme changes.
function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
  renderSparkline();
}

// Sidebar resize functionality
function initSidebarResize() {
  const sidebar = document.getElementById("sidebar");
  const handle = document.getElementById("sidebarResizeHandle");
  let isResizing = false;

  handle.addEventListener("mousedown", (e) => {
    isResizing = true;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    const newWidth = e.clientX;
    const minWidth = 280;
    const maxWidth = 800;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      sidebar.style.width = newWidth + "px";
      localStorage.setItem("sidebarWidth", newWidth);
    }
  });

  document.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });

  // Restore saved width
  const savedWidth = localStorage.getItem("sidebarWidth");
  if (savedWidth) {
    sidebar.style.width = savedWidth + "px";
  }
}

// Viz panel toggle functionality
function setVizWidth(isCollapsed) {
  document.documentElement.style.setProperty(
    "--viz-width",
    isCollapsed ? "44px" : "240px",
  );
}

function toggleVizPanel() {
  const panel = document.getElementById("vizPanel");
  const toggle = document.getElementById("vizPanelToggle");

  panel.classList.toggle("collapsed");
  const isCollapsed = panel.classList.contains("collapsed");

  toggle.title = isCollapsed ? "Expand stats panel" : "Hide stats panel";
  localStorage.setItem("vizPanelCollapsed", isCollapsed);
  setVizWidth(isCollapsed);

  // Re-render sparkline after transition
  setTimeout(renderSparkline, 250);
}

// Restore viz panel state
function initVizPanel() {
  const savedState = localStorage.getItem("vizPanelCollapsed");
  const panel = document.getElementById("vizPanel");
  const toggle = document.getElementById("vizPanelToggle");

  // Default to collapsed, but check localStorage
  if (savedState === "false") {
    panel.classList.remove("collapsed");
    toggle.title = "Hide stats panel";
    setVizWidth(false);
  } else {
    setVizWidth(true);
  }
}

// Format time
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFullTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return (
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
    " · " +
    d.toLocaleDateString()
  );
}

// Escape HTML
function esc(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function escAttr(text) {
  return esc(text).replace(/"/g, "&quot;");
}

function domId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "-");
}

function getTranscriptKey(transcript) {
  return transcript?.summary?.id || transcript?.task_part_id || "";
}

function getSubagentOccurrenceSegment(part, transcript, partIndex) {
  const key =
    getTranscriptKey(transcript) ||
    getSubagentSessionId(part) ||
    part?.id ||
    "subagent";
  return `p${partIndex}-${key}`;
}

function getSubagentOccurrencePath(parentIndex, pathSegments = []) {
  return [`msg${parentIndex}`, ...pathSegments].map(domId).join("__");
}

function getSubagentMessageDomId(subagentPath, subagentIndex) {
  return `submsg-${domId(subagentPath)}-${subagentIndex}`;
}

function getAgentMessageDomId(agentId, messageIndex) {
  return agentId === "main"
    ? `msg-${messageIndex}`
    : getSubagentMessageDomId(agentId, messageIndex);
}

function getActivityDomId(activityPath) {
  return `activity-${domId(activityPath)}`;
}

function getSpawnPromptDomId(subagentPath) {
  return `spawn-prompt-${domId(subagentPath)}`;
}

function getToolOccurrenceSegment(part, partIndex) {
  return `tool${partIndex}-${part?.id || part?.tool || "tool"}`;
}

function getToolActivityPath(part, context = {}) {
  return getSubagentOccurrencePath(context.parentIndex, [
    ...(context.subagentPathSegments || []),
    getToolOccurrenceSegment(part, context.partIndex || 0),
  ]);
}

function getLinkedSubagentPath(part, transcript, context = {}) {
  if (!transcript) return "";
  return getSubagentOccurrencePath(context.parentIndex, [
    ...(context.subagentPathSegments || []),
    getSubagentOccurrenceSegment(part, transcript, context.partIndex || 0),
  ]);
}

function stringifyValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function compactText(text, maxLength = 300) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > maxLength
    ? normalized.substring(0, maxLength) + "..."
    : normalized;
}

function getSubagentSessionId(part) {
  return (
    part?.state?.metadata?.sessionId || part?.state?.metadata?.session_id || ""
  );
}

function getSubagentTranscriptForPart(
  part,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const sessionId = getSubagentSessionId(part);
  return (subagents || []).find((transcript) => {
    return (
      (part?.id && transcript.task_part_id === part.id) ||
      (sessionId && transcript.summary?.id === sessionId)
    );
  });
}

function getMessageSubagentTranscriptRefs(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const refs = [];
  (msg.parts || []).forEach((part, partIndex) => {
    const transcript = getSubagentTranscriptForPart(part, subagents);
    if (transcript) refs.push({ part, partIndex, transcript });
  });
  return refs;
}

function getMessageSubagentTranscripts(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  const transcripts = [];
  getMessageSubagentTranscriptRefs(msg, subagents).forEach(({ transcript }) => {
    transcripts.push(transcript);
  });
  return transcripts;
}

function getAgentTitle(track) {
  if (!track) return "Agent";
  if (track.id === "main") return "Main agent";
  return (
    track.transcript?.summary?.title ||
    track.transcript?.summary?.id ||
    "Subagent"
  );
}

function getMessageModelId(msg) {
  return (
    msg?.model?.modelID ||
    msg?.modelID ||
    (typeof msg?.model === "string" ? msg.model : "") ||
    ""
  );
}

function getTrackModel(track) {
  if (!track) return "";
  const summaryModel =
    track.transcript?.summary?.model ||
    (track.id === "main" ? SESSION_DATA?.summary?.model : "");
  if (summaryModel && summaryModel !== "Unknown") return summaryModel;

  const models = Array.from(
    new Set((track.messages || []).map(getMessageModelId).filter(Boolean)),
  );
  if (models.length === 1) return models[0];
  if (models.length > 1) return `${models.length} models`;
  return "";
}

function getAgentTracks() {
  if (!SESSION_DATA) return [];

  const tracks = [
    {
      id: "main",
      kind: "main",
      title: "Main agent",
      agent: "main",
      messages: SESSION_DATA.messages || [],
      subagents: SESSION_DATA.subagent_transcripts || [],
      parentIndex: null,
      parentAgentId: "",
      sourceMessageIndex: null,
      sourcePartIndex: null,
      sourcePartId: "",
      sourceTime: SESSION_DATA.messages?.[0]?.time_created || "",
      pathSegments: [],
      transcript: null,
      spawnPrompt: "",
    },
  ];
  const seenTranscriptKeys = new Set();
  const topSubagents = SESSION_DATA.subagent_transcripts || [];

  (SESSION_DATA.messages || []).forEach((msg, messageIndex) => {
    getMessageSubagentTranscriptRefs(msg, topSubagents).forEach(
      ({ part, partIndex, transcript }) => {
        collectAgentTrack(tracks, seenTranscriptKeys, transcript, {
          parentIndex: messageIndex,
          parentAgentId: "main",
          sourceMessageIndex: messageIndex,
          sourcePartIndex: partIndex,
          sourcePartId: part?.id || "",
          sourceTime: msg.time_created || "",
          pathSegments: [
            getSubagentOccurrenceSegment(part, transcript, partIndex),
          ],
          parentActivityPath: "",
          spawnPrompt: getTaskPrompt(part),
        });
      },
    );
  });

  topSubagents.forEach((transcript, index) => {
    const key =
      transcript.summary?.id || transcript.task_part_id || `orphan-${index}`;
    if (seenTranscriptKeys.has(key)) return;
    collectAgentTrack(tracks, seenTranscriptKeys, transcript, {
      parentIndex: SESSION_DATA.messages.length + index,
      parentAgentId: "main",
      sourceMessageIndex: null,
      sourcePartIndex: null,
      sourcePartId: transcript.task_part_id || "",
      sourceTime: transcript.messages?.[0]?.time_created || "",
      pathSegments: [`unlinked-${key}`],
      parentActivityPath: "",
      spawnPrompt: "",
      unlinked: true,
    });
  });

  return tracks;
}

function collectAgentTrack(tracks, seenTranscriptKeys, transcript, context) {
  const id = getSubagentOccurrencePath(
    context.parentIndex,
    context.pathSegments,
  );
  const transcriptKey =
    transcript.summary?.id ||
    transcript.task_part_id ||
    id ||
    `track-${tracks.length}`;
  seenTranscriptKeys.add(transcriptKey);

  const track = {
    id,
    kind: "subagent",
    title: transcript.summary?.title || transcript.summary?.id || "Subagent",
    agent: transcript.agent_type || transcript.summary?.model || "subagent",
    messages: transcript.messages || [],
    subagents: transcript.subagent_transcripts || [],
    parentIndex: context.parentIndex,
    parentAgentId: context.parentAgentId,
    parentActivityPath: context.parentActivityPath || "",
    sourceMessageIndex: context.sourceMessageIndex,
    sourcePartIndex: context.sourcePartIndex,
    sourcePartId: context.sourcePartId || "",
    sourceTime: context.sourceTime || "",
    pathSegments: context.pathSegments,
    transcript,
    spawnPrompt: context.spawnPrompt || "",
    unlinked: Boolean(context.unlinked),
  };
  tracks.push(track);

  (transcript.messages || []).forEach((msg, messageIndex) => {
    getMessageSubagentTranscriptRefs(
      msg,
      transcript.subagent_transcripts || [],
    ).forEach(({ part, partIndex, transcript: childTranscript }) => {
      collectAgentTrack(tracks, seenTranscriptKeys, childTranscript, {
        parentIndex: context.parentIndex,
        parentAgentId: id,
        parentActivityPath: id,
        sourceMessageIndex: messageIndex,
        sourcePartIndex: partIndex,
        sourcePartId: part?.id || "",
        sourceTime: msg.time_created || context.sourceTime || "",
        pathSegments: [
          ...context.pathSegments,
          `msg${messageIndex}`,
          getSubagentOccurrenceSegment(part, childTranscript, partIndex),
        ],
        spawnPrompt: getTaskPrompt(part),
      });
    });
  });
}

function getSelectedAgentTrack() {
  const tracks = getAgentTracks();
  return tracks.find((track) => track.id === selectedAgentId) || tracks[0];
}

function ensureSelectedAgentTrack(tracks = getAgentTracks()) {
  if (!tracks.length) return null;
  const selected = tracks.find((track) => track.id === selectedAgentId);
  if (selected) return selected;
  selectedAgentId = "main";
  return tracks.find((track) => track.id === "main") || tracks[0];
}

function reconcileOpenSubagentPanels(tracks = getAgentTracks()) {
  const trackIds = new Set(tracks.map((track) => track.id));
  Array.from(openSubagentPanelIds).forEach((agentId) => {
    if (!trackIds.has(agentId)) {
      openSubagentPanelIds.delete(agentId);
    }
  });

  if (!trackIds.has(selectedAgentId)) {
    selectedAgentId = "main";
  }
}

function getSubagentAncestorIds(agentId, tracks = getAgentTracks()) {
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const ancestors = [];
  let current = trackById.get(agentId);

  while (current?.parentAgentId && current.parentAgentId !== "main") {
    const parent = trackById.get(current.parentAgentId);
    if (!parent || parent.kind !== "subagent") break;
    ancestors.unshift(parent.id);
    current = parent;
  }

  return ancestors;
}

function getSubagentDescendantIds(agentId, tracks = getAgentTracks()) {
  const descendants = [];

  function collect(parentId) {
    tracks
      .filter(
        (track) =>
          track.kind === "subagent" && track.parentAgentId === parentId,
      )
      .forEach((track) => {
        descendants.push(track.id);
        collect(track.id);
      });
  }

  collect(agentId);
  return descendants;
}

function openSubagentPanel(agentId, tracks = getAgentTracks()) {
  const track = tracks.find((candidate) => candidate.id === agentId);
  if (!track || track.kind !== "subagent") return false;

  getSubagentAncestorIds(agentId, tracks).forEach((ancestorId) => {
    openSubagentPanelIds.add(ancestorId);
  });
  openSubagentPanelIds.add(agentId);
  return true;
}

function closeSubagentPanel(agentId, event = null) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const tracks = getAgentTracks();
  [agentId, ...getSubagentDescendantIds(agentId, tracks)].forEach((id) => {
    openSubagentPanelIds.delete(id);
  });

  if (!openSubagentPanelIds.has(selectedAgentId)) {
    selectedAgentId = "main";
  }

  sidebarNavigationLock = null;
  renderSidebar();
  renderTimeline();
}

function getOpenSubagentTracks(tracks = getAgentTracks()) {
  reconcileOpenSubagentPanels(tracks);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  return Array.from(openSubagentPanelIds)
    .map((agentId) => trackById.get(agentId))
    .filter((track) => track?.kind === "subagent");
}

function getTaskPrompt(part) {
  const input = part?.state?.input || {};
  return input.prompt || input.description || part?.state?.title || "";
}

function messageHasSubagentTranscript(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  return getMessageSubagentTranscripts(msg, subagents).length > 0;
}

function getTranscriptText(transcript) {
  let text = [
    transcript.summary?.title || "",
    transcript.summary?.id || "",
    transcript.agent_type || "",
  ].join(" ");

  (transcript.messages || []).forEach((msg) => {
    text +=
      " " + getMessageSearchText(msg, transcript.subagent_transcripts || []);
  });

  return text;
}

function getToolText(part) {
  if (part?.type !== "tool") return "";
  const state = part.state || {};
  return [
    part.tool,
    state.title,
    state.status,
    stringifyValue(state.input),
    stringifyValue(state.output),
    stringifyValue(state.error),
  ]
    .filter(Boolean)
    .join(" ");
}

function getToolPreview(part, options = {}) {
  const includeResultDetails = options.includeResultDetails !== false;
  const state = part.state || {};
  const output = stringifyValue(state.output);
  const input = stringifyValue(state.input);
  const detailParts = includeResultDetails
    ? [state.title, output || input || state.status]
    : [state.title || state.status];
  const detail = detailParts.filter(Boolean).join(" - ");
  const toolName = part.tool || "tool";
  return compactText(`Tool (${toolName})${detail ? `: ${detail}` : ""}`);
}

// Determine if a message is an intermediate assistant step.
// vs a final/substantive assistant response.
// An intermediate step is an assistant message that either:
//   - has finish == "tool-calls" (stopped to invoke tools), or
//   - has no "text" parts and no finish=="stop" (pure step-start/step-finish/tool sequences)
function isIntermediateStep(msg) {
  if (msg.role !== "assistant") return false;
  if (msg.finish === "stop") return false;
  const hasText = (msg.parts || []).some(
    (part) => part.type === "text" && part.text && !part.synthetic,
  );
  if (hasText && msg.finish !== "tool-calls") return false;
  return true;
}

// Get preview
function getPreview(msg) {
  const textPart = msg.parts?.find((p) => p.type === "text");
  if (textPart?.text) {
    // Return first paragraph (split by double newline or newline)
    const text = textPart.text.trim();
    const firstPara = text.split(/\n\s*\n/)[0];
    return compactText(firstPara);
  }
  const taskPart = msg.parts?.find(
    (p) => p.type === "tool" && p.tool === "task",
  );
  if (taskPart) {
    const transcript = getSubagentTranscriptForPart(taskPart);
    const state = taskPart.state || {};
    const input = state.input || {};
    const agent = input.subagent_type || transcript?.agent_type || "subagent";
    const title =
      transcript?.summary?.title || input.description || input.prompt;
    if (title) return `Subagent (${agent}): ${title}`;
  }
  const toolPart = msg.parts?.find((p) => p.type === "tool");
  if (toolPart) {
    return getToolPreview(toolPart, {
      includeResultDetails: !isIntermediateStep(msg),
    });
  }
  return msg.summary?.title || "";
}

function getMessageSearchText(
  msg,
  subagents = SESSION_DATA?.subagent_transcripts || [],
) {
  let text = "";
  (msg.parts || []).forEach((p) => {
    if (p.type === "text" && p.text) {
      text += p.text + " ";
    }
    if (p.type === "tool") {
      text += getToolText(p) + " ";
    }
    if (p.type === "tool" && p.tool === "task") {
      const state = p.state || {};
      const input = state.input || {};
      text += [input.description, input.prompt, state.output]
        .filter(Boolean)
        .join(" ");

      const transcript = getSubagentTranscriptForPart(p, subagents);
      if (transcript) {
        text += " " + getTranscriptText(transcript);
      }
    }
  });
  return text;
}

// Get full text content of a message for filtering
function getFullText(msg) {
  const text = getMessageSearchText(msg);
  return text.toLowerCase();
}

// Highlight filter terms in text
function highlightText(text, query) {
  if (!query) return esc(text);

  // Escape the text first
  const escaped = esc(text);

  // Create a case-insensitive regex for the filter term
  // Escape regex special characters in the query
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");

  return escaped.replace(regex, "<mark>$1</mark>");
}

// Get a snippet around the filter match
function getMatchSnippet(msg, query) {
  if (!query) return null;

  const text = getMessageSearchText(msg).trim();
  if (!text) return null;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) return null;

  // Get context around the match
  const contextSize = 100;
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + query.length + contextSize);

  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return snippet;
}

// Extract token data from message
function getMessageTokens(msg) {
  let input = 0,
    output = 0,
    cache = 0;
  (msg.parts || []).forEach((p) => {
    if (p.type === "step-finish" && p.tokens) {
      input += p.tokens.input || 0;
      output += p.tokens.output || 0;
      cache += p.tokens.cache?.read || 0;
    }
  });
  return { input, output, cache };
}

// Build token data array
function buildTokenData() {
  if (!SESSION_DATA) return;
  tokenData = SESSION_DATA.messages.map((m) => getMessageTokens(m));
  maxTokens = {
    input: Math.max(1, ...tokenData.map((t) => t.input)),
    output: Math.max(1, ...tokenData.map((t) => t.output)),
    cache: Math.max(1, ...tokenData.map((t) => t.cache)),
  };
}

// Update visualization for current message
function updateViz(index) {
  if (!SESSION_DATA || tokenData.length === 0) return;

  currentMessageIndex = index;
  const t = tokenData[index] || { input: 0, output: 0, cache: 0 };

  // Update bars
  document.getElementById("inputBar").style.width =
    (t.input / maxTokens.input) * 100 + "%";
  document.getElementById("outputBar").style.width =
    (t.output / maxTokens.output) * 100 + "%";
  document.getElementById("cacheBar").style.width =
    (t.cache / maxTokens.cache) * 100 + "%";

  // Update values
  document.getElementById("inputValue").textContent = t.input.toLocaleString();
  document.getElementById("outputValue").textContent =
    t.output.toLocaleString();
  document.getElementById("cacheValue").textContent = t.cache.toLocaleString();

  // Update progress
  const progress = ((index + 1) / SESSION_DATA.messages.length) * 100;
  document.getElementById("progressBar").style.width = progress + "%";
  document.getElementById("progressLabel").textContent =
    `Message ${index + 1} / ${SESSION_DATA.messages.length}`;

  // Update sparkline marker
  renderSparkline();
}

// Render sparkline
function renderSparkline() {
  if (!SESSION_DATA || tokenData.length === 0) return;

  const svg = document.getElementById("sparkline");
  const width = svg.clientWidth || 200;
  const height = svg.clientHeight || 80;
  const padding = { top: 10, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxCache = Math.max(1, ...tokenData.map((t) => t.cache));

  // Generate points
  const points = tokenData.map((t, i) => {
    const x = padding.left + (i / (tokenData.length - 1 || 1)) * chartWidth;
    const y = padding.top + chartHeight - (t.cache / maxCache) * chartHeight;
    return { x, y };
  });

  // Create path
  const pathD = points
    .map((p, i) => (i === 0 ? "M" : "L") + p.x + "," + p.y)
    .join(" ");
  const areaD =
    pathD +
    ` L${points[points.length - 1].x},${padding.top + chartHeight} L${padding.left},${padding.top + chartHeight} Z`;

  // Current position
  const currentX =
    padding.left +
    (currentMessageIndex / (tokenData.length - 1 || 1)) * chartWidth;
  const currentY = points[currentMessageIndex]?.y || padding.top + chartHeight;

  svg.innerHTML = `
        <path class="sparkline-area" d="${areaD}"/>
        <path class="sparkline-path" d="${pathD}"/>
        <line class="sparkline-position-line" x1="${currentX}" y1="${padding.top}" x2="${currentX}" y2="${padding.top + chartHeight}"/>
        <circle class="sparkline-marker" cx="${currentX}" cy="${currentY}" r="5"/>
    `;
}

function setActiveSidebarAgentMessage(agentId, messageIndex) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle(
      "active",
      !item.dataset.activityPath &&
        item.dataset.agentId === agentId &&
        Number(item.dataset.messageIndex) === messageIndex,
    );
  });
}

function setActiveSidebarActivity(activityPath) {
  document.querySelectorAll(".message-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.activityPath === activityPath);
  });
}

// Scroll to message
function setActiveSidebarMessage(idx) {
  setActiveSidebarAgentMessage("main", idx);
}

function clearSidebarNavigationLock() {
  sidebarNavigationLock = null;
}

function clearHighlightedTargets() {
  document
    .querySelectorAll(".highlighted")
    .forEach((el) => el.classList.remove("highlighted"));
}

function scrollElementVerticallyIntoContainer(
  el,
  container,
  { block = "start", topOffset = 0 } = {},
) {
  const elRect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  let deltaTop = elRect.top - containerRect.top - topOffset;

  if (block === "nearest") {
    const visibleTop = containerRect.top + topOffset;
    const visibleBottom = containerRect.bottom;
    if (elRect.top < visibleTop) {
      deltaTop = elRect.top - visibleTop;
    } else if (elRect.bottom > visibleBottom) {
      deltaTop = elRect.bottom - visibleBottom;
    } else {
      deltaTop = 0;
    }
  } else if (block === "center") {
    deltaTop =
      elRect.top -
      containerRect.top -
      (containerRect.height - elRect.height) / 2;
  }

  if (Math.abs(deltaTop) > 1) {
    container.scrollTop = Math.max(0, container.scrollTop + deltaTop);
  }
}

function scrollElementHorizontallyIntoContainer(el, container) {
  const elRect = el.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const styles = window.getComputedStyle(container);
  const visibleLeft =
    containerRect.left + (parseFloat(styles.paddingLeft) || 0);
  const visibleRight =
    containerRect.right - (parseFloat(styles.paddingRight) || 0);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  let deltaLeft = 0;

  if (elRect.width >= visibleWidth || elRect.left < visibleLeft) {
    deltaLeft = elRect.left - visibleLeft;
  } else if (elRect.right > visibleRight) {
    deltaLeft = elRect.right - visibleRight;
  }

  if (Math.abs(deltaLeft) > 1) {
    const scrollBounds = getHorizontalScrollBounds(container);
    container.scrollLeft = clamp(
      container.scrollLeft + deltaLeft,
      scrollBounds.min,
      scrollBounds.max,
    );
  }
}

function getHorizontalScrollBounds(container) {
  if (!container) return { min: 0, max: 0 };

  const maxDistance = Math.max(
    0,
    container.scrollWidth - container.clientWidth,
  );
  const styles = window.getComputedStyle(container);
  if (styles.flexDirection === "row-reverse") {
    return { min: -maxDistance, max: 0 };
  }

  return { min: 0, max: maxDistance };
}

function scrollHorizontalContainerToRightEdge(container) {
  const scrollBounds = getHorizontalScrollBounds(container);
  container.scrollLeft = scrollBounds.max;
}

function scrollTranscriptElementIntoView(
  el,
  { block = "start", pauseMainPanelSync = false } = {},
) {
  const panel = el.classList.contains("subagent-panel")
    ? el
    : el.closest(".subagent-panel");
  if (panel) {
    if (pauseMainPanelSync) {
      suppressMainPanelSyncUntil = Date.now() + 750;
    }
    const rack = panel.closest(".subagent-panel-rack");
    if (rack) {
      scrollElementHorizontallyIntoContainer(panel, rack);
    }

    if (el !== panel) {
      const panelHeader = panel.querySelector(":scope > .agent-track-header");
      const panelTopOffset = panelHeader
        ? panelHeader.getBoundingClientRect().height + 8
        : 0;
      scrollElementVerticallyIntoContainer(el, panel, {
        block: "nearest",
        topOffset: panelTopOffset,
      });
    }
    scheduleSubagentAlignment();
    return;
  }

  const mainContent = document.getElementById("mainContent");
  if (mainContent?.contains(el)) {
    scrollElementVerticallyIntoContainer(el, mainContent, {
      block,
      topOffset: 24,
    });
    scheduleSubagentAlignment();
    return;
  }

  el.scrollIntoView({ behavior: "smooth", block, inline: "nearest" });
  scheduleSubagentAlignment();
}

function scrollToDomId(targetId, lock = null, options = {}) {
  const el = document.getElementById(targetId);
  if (!el) return;

  sidebarNavigationLock = lock;
  clearHighlightedTargets();

  scrollTranscriptElementIntoView(el, options);
  el.classList.add("highlighted");

  setTimeout(() => {
    el.classList.remove("highlighted");
  }, 2000);
}

function scrollToAgentMessage(agentId, messageIndex) {
  const tracks = getAgentTracks();
  const track = tracks.find((candidate) => candidate.id === agentId);
  if (!track) return;

  if (track.kind === "subagent" && !openSubagentPanelIds.has(agentId)) {
    openSubagentPanel(agentId, tracks);
    selectedAgentId = agentId;
    sidebarNavigationLock = null;
    renderSidebar();
    renderTimeline();
    requestAnimationFrame(() => scrollToAgentMessage(agentId, messageIndex));
    return;
  }

  if (selectedAgentId !== agentId) {
    selectedAgentId = agentId;
    sidebarNavigationLock = null;
    renderSidebar();
    renderTimeline();
  }

  const el = document.getElementById(
    getAgentMessageDomId(agentId, messageIndex),
  );
  if (!el) return;

  scrollToDomId(
    getAgentMessageDomId(agentId, messageIndex),
    {
      kind: "agent-message",
      agentId,
      messageIndex,
    },
    { pauseMainPanelSync: track.kind === "subagent" },
  );
  highlightedId = track.id === "main" ? messageIndex : track.parentIndex;
  setActiveSidebarAgentMessage(agentId, messageIndex);
  updateViz(track.id === "main" ? messageIndex : track.parentIndex || 0);
}

function scrollToMessage(idx) {
  scrollToAgentMessage("main", idx);
}

function scrollToSubagentMessage(
  transcriptId,
  subagentIndex,
  parentIndex,
  subagentPath,
) {
  scrollToAgentMessage(subagentPath, subagentIndex);
}

function setToolResultExpanded(activityPath, expanded) {
  const card = document.getElementById(getActivityDomId(activityPath));
  if (!card) return null;

  card.classList.toggle("expanded", expanded);
  card.setAttribute("aria-hidden", expanded ? "false" : "true");
  document
    .querySelectorAll(`[data-tool-result-button="${CSS.escape(activityPath)}"]`)
    .forEach((button) => {
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      button.textContent = expanded ? "hide result" : "tool result";
    });

  if (expanded) {
    expandedToolResults.add(activityPath);
  } else {
    expandedToolResults.delete(activityPath);
  }

  scheduleSubagentAlignment();

  return card;
}

function showToolResult(activityPath, agentId = "", messageIndex = null) {
  if (agentId) {
    const tracks = getAgentTracks();
    const track = tracks.find((candidate) => candidate.id === agentId);
    if (track?.kind === "subagent" && !openSubagentPanelIds.has(agentId)) {
      openSubagentPanel(agentId, tracks);
      selectedAgentId = agentId;
      sidebarNavigationLock = null;
      renderSidebar();
      renderTimeline();
      requestAnimationFrame(() =>
        showToolResult(activityPath, agentId, messageIndex),
      );
      return;
    }
  }

  if (agentId && selectedAgentId !== agentId) {
    selectedAgentId = agentId;
    sidebarNavigationLock = null;
    renderSidebar();
    renderTimeline();
    requestAnimationFrame(() =>
      showToolResult(activityPath, agentId, messageIndex),
    );
    return;
  }

  const el = setToolResultExpanded(activityPath, true);
  if (!el) return;

  const hasParentMessage = agentId && Number.isFinite(messageIndex);
  sidebarNavigationLock = activityPath
    ? { kind: "activity", activityPath, agentId, messageIndex }
    : hasParentMessage
      ? { kind: "agent-message", agentId, messageIndex }
      : null;
  renderSidebar();
  clearHighlightedTargets();

  scrollTranscriptElementIntoView(el);
  syncSubagentPanelsToMain();
  scheduleSubagentAlignment();
  el.classList.add("highlighted");
  if (activityPath) {
    setActiveSidebarActivity(activityPath);
  } else if (hasParentMessage) {
    setActiveSidebarAgentMessage(agentId, messageIndex);
  }

  if (agentId && Number.isFinite(messageIndex)) {
    const track = getAgentTracks().find(
      (candidate) => candidate.id === agentId,
    );
    updateViz(track?.id === "main" ? messageIndex : track?.parentIndex || 0);
  }

  setTimeout(() => {
    el.classList.remove("highlighted");
  }, 2000);
}

function toggleToolResult(activityPath, agentId = "", messageIndex = null) {
  const el = document.getElementById(getActivityDomId(activityPath));
  if (!el) return;

  const parsedMessageIndex =
    messageIndex === null || messageIndex === undefined
      ? null
      : Number(messageIndex);

  if (el.classList.contains("expanded")) {
    setToolResultExpanded(activityPath, false);
    if (agentId && Number.isFinite(parsedMessageIndex)) {
      sidebarNavigationLock = {
        kind: "agent-message",
        agentId,
        messageIndex: parsedMessageIndex,
      };
      renderSidebar();
      setActiveSidebarAgentMessage(agentId, parsedMessageIndex);
    } else {
      sidebarNavigationLock = null;
      renderSidebar();
    }
    return;
  }

  showToolResult(
    activityPath,
    agentId,
    Number.isFinite(parsedMessageIndex) ? parsedMessageIndex : null,
  );
}

function scrollToActivity(activityPath) {
  showToolResult(activityPath);
}

// Detect visible message on scroll
function detectVisibleMessage() {
  if (!SESSION_DATA) return;
  if (sidebarNavigationLock) return;

  const mainContent = document.getElementById("mainContent");
  const scrollTop = mainContent.scrollTop;
  const viewportHeight = mainContent.clientHeight;
  const viewportCenter = scrollTop + viewportHeight / 3;
  const track = getSelectedAgentTrack();
  if (!track) return;

  let closestIdx = currentMessageIndex;
  let closestDist = Infinity;

  document
    .querySelectorAll(
      `.agent-track[data-agent-id="${CSS.escape(track.id)}"] .agent-track-message`,
    )
    .forEach((el) => {
      const messageIndex = Number(el.dataset.messageIndex);
      const elTop = el.offsetTop;
      const dist = Math.abs(elTop - viewportCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = messageIndex;
      }
    });

  if (closestDist === Infinity) return;

  setActiveSidebarAgentMessage(track.id, closestIdx);
  if (track.id === "main" && closestIdx !== currentMessageIndex) {
    updateViz(closestIdx);
  } else if (track.id !== "main") {
    const parentIndex = track.parentIndex || 0;
    if (parentIndex !== currentMessageIndex) {
      updateViz(parentIndex);
    }
  }
}

// Format markdown tables from "machine view" (compact) to "human view" (padded columns)
function formatMarkdownTables(text) {
  const lines = text.split("\n");
  const result = [];
  let i = 0;

  while (i < lines.length) {
    // Detect a table block: a line that starts and ends with | (ignoring whitespace)
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      // Collect all consecutive table lines
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i].trim());
        i++;
      }

      // Parse each row into cells
      const rows = tableLines.map((line) => {
        // Strip leading/trailing pipes then split
        const inner = line.replace(/^\||\|$/g, "");
        return inner.split("|").map((cell) => cell.trim());
      });

      // Identify the separator row (all cells match /^:?-+:?$/)
      const sepIdx = rows.findIndex((row) =>
        row.every((cell) => /^:?-+:?$/.test(cell)),
      );

      if (sepIdx === -1 || rows.length < 2) {
        // Not a real table — emit as-is
        tableLines.forEach((l) => result.push(l));
        continue;
      }

      // Determine column count from the widest row
      const colCount = Math.max(...rows.map((r) => r.length));

      // Compute max width per column
      const colWidths = Array(colCount).fill(1);
      rows.forEach((row, ri) => {
        if (ri === sepIdx) return; // Skip separator row for width calc
        row.forEach((cell, ci) => {
          if (ci < colCount) {
            colWidths[ci] = Math.max(colWidths[ci], cell.length);
          }
        });
      });
      // Ensure separator dashes fill the column width
      colWidths.forEach((w, ci) => {
        colWidths[ci] = Math.max(w, 3); // At minimum "---"
      });

      // Rebuild rows
      rows.forEach((row, ri) => {
        const cells = Array(colCount)
          .fill("")
          .map((_, ci) => row[ci] ?? "");

        let formatted;
        if (ri === sepIdx) {
          // Separator row: pipes and dashes only, no spaces.
          // Each data cell is padEnd(w) surrounded by " | ", so each separator
          // segment must be w+2 dashes wide to match the visual column width.
          formatted =
            "|" +
            cells
              .map((cell, ci) => {
                const w = colWidths[ci] + 2;
                if (/^:-+:$/.test(cell))
                  return ":" + "-".repeat(w - 2) + ":" + "|";
                if (/^:-+$/.test(cell)) return ":" + "-".repeat(w - 1) + "|";
                if (/^-+:$/.test(cell)) return "-".repeat(w - 1) + ":" + "|";
                return "-".repeat(w) + "|";
              })
              .join("");
        } else {
          formatted =
            "| " +
            cells.map((cell, ci) => cell.padEnd(colWidths[ci])).join(" | ") +
            " |";
        }
        result.push(formatted);
      });
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

// Copy markdown to clipboard
function copyMarkdown(idx) {
  const msg = SESSION_DATA.messages[idx];
  if (!msg) return;

  let markdown = "";
  (msg.parts || []).forEach((p) => {
    if (p.type === "text" && p.text) {
      markdown += p.text + "\n\n";
    } else if (p.type === "tool") {
      const st = p.state || {};
      markdown += `> **Tool: ${p.tool}**\n`;
      if (st.title) markdown += `> ${st.title}\n`;
      if (st.input)
        markdown += "```json\n" + JSON.stringify(st.input, null, 2) + "\n```\n";
      if (st.output) {
        markdown += "#### Output\n";
        markdown +=
          "```\n" +
          (typeof st.output === "string"
            ? st.output
            : JSON.stringify(st.output, null, 2)) +
          "\n```\n";
      }
      markdown += "\n";
    }
  });

  navigator.clipboard
    .writeText(formatMarkdownTables(markdown.trim()))
    .then(() => {
      const btn = document.querySelector(`#msg-${idx} .copy-btn`);
      const originalHtml = btn.innerHTML;
      btn.innerHTML = "<span>✅</span> Copied";
      btn.style.borderColor = "var(--accent-green)";
      btn.style.color = "var(--accent-green)";
      setTimeout(() => {
        btn.innerHTML = originalHtml;
        btn.style.borderColor = "";
        btn.style.color = "";
      }, 2000);
    })
    .catch((err) => {
      console.error("Failed to copy: ", err);
    });
}

// Render sidebar list
function renderAgentFilter(location) {
  const tracks = getAgentTracks();
  if (!tracks.length) return "";
  ensureSelectedAgentTrack(tracks);
  reconcileOpenSubagentPanels(tracks);

  return `
        <div class="agent-filter" data-agent-filter-location="${escAttr(location)}" role="listbox" aria-label="Agent stream selector">
            ${tracks
              .map((track) => {
                const active = track.id === selectedAgentId;
                const panelOpen =
                  track.kind === "subagent" &&
                  openSubagentPanelIds.has(track.id);
                const count = track.messages.length;
                return `
                    <button type="button" class="agent-filter-option ${active ? "active" : ""} ${panelOpen ? "panel-open" : ""}" role="option" aria-selected="${active ? "true" : "false"}" aria-pressed="${panelOpen ? "true" : "false"}" data-agent-id="${escAttr(track.id)}" data-track-kind="${escAttr(track.kind)}" data-panel-open="${panelOpen ? "true" : "false"}" onclick="selectAgentTrack(this.dataset.agentId)">
                        <span class="agent-filter-kind">${track.kind === "main" ? "main" : "subagent"}</span>
                        <span class="agent-filter-title">${esc(getAgentTitle(track))}</span>
                        <span class="agent-filter-count">${count}</span>
                    </button>
                `;
              })
              .join("")}
        </div>
    `;
}

function renderSelectedAgentStrip(location) {
  const tracks = getAgentTracks();
  const selectedTracks = getOpenSubagentTracks(tracks);
  if (!selectedTracks.length) return "";

  return `
        <div class="selected-agent-strip" data-selected-agent-strip-location="${escAttr(location)}" aria-label="Open subagent panels">
            ${selectedTracks
              .map(
                (track) => `
                    <button type="button" class="selected-agent-chip ${track.id === selectedAgentId ? "active" : ""}" data-agent-id="${escAttr(track.id)}" onclick="selectAgentTrack(this.dataset.agentId)">
                        <span>${esc(getAgentTitle(track))}</span>
                        <span class="selected-agent-chip-close" aria-label="Close ${escAttr(getAgentTitle(track))}" onclick="closeSubagentPanel('${escAttr(track.id)}', event)">×</span>
                    </button>
                `,
              )
              .join("")}
        </div>
    `;
}

function getSidebarAgentFilter() {
  return document.querySelector(
    '.agent-filter[data-agent-filter-location="sidebar"]',
  );
}

function captureSidebarAgentFilterScroll() {
  const filter = getSidebarAgentFilter();
  if (filter) {
    sidebarAgentFilterScrollLeft = filter.scrollLeft;
  }
}

function restoreSidebarAgentFilterScroll() {
  const filter = getSidebarAgentFilter();
  if (!filter) return;

  const maxScrollLeft = Math.max(0, filter.scrollWidth - filter.clientWidth);
  filter.scrollLeft = Math.min(sidebarAgentFilterScrollLeft, maxScrollLeft);
  filter.addEventListener(
    "scroll",
    () => {
      sidebarAgentFilterScrollLeft = filter.scrollLeft;
    },
    { passive: true },
  );
}

function selectAgentTrack(agentId) {
  if (!agentId || selectedAgentId === agentId) return;
  const tracks = getAgentTracks();
  const track = tracks.find((candidate) => candidate.id === agentId);
  if (!track) return;

  if (track.kind === "subagent") {
    openSubagentPanel(agentId, tracks);
  }

  selectedAgentId = agentId;
  sidebarNavigationLock = null;
  renderSidebar();
  renderTimeline();

  requestAnimationFrame(() => {
    const track = document.querySelector(
      `.agent-track[data-agent-id="${CSS.escape(agentId)}"]`,
    );
    if (track) {
      scrollTranscriptElementIntoView(track, { block: "nearest" });
    }
  });
}

function renderSidebar() {
  if (!SESSION_DATA) return;

  captureSidebarAgentFilterScroll();

  // Determine which query to use for filtering (typed filter takes precedence over URL search)
  const activeSearch = filterQuery || urlSearchQuery;
  const items = buildSidebarItems(activeSearch);

  const list = document.getElementById("messageList");
  list.innerHTML =
    renderAgentFilter("sidebar") +
    renderSelectedAgentStrip("sidebar") +
    items
      .map((item) => {
        let previewHtml;
        if (activeSearch) {
          previewHtml = highlightText(
            getSidebarMatchSnippet(item, activeSearch),
            activeSearch,
          );
        } else {
          previewHtml = esc(item.preview);
        }
        const itemClasses = [
          "message-item",
          item.kind === "tool" ? "tool-result-item" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const activityAttr = item.activityPath
          ? ` data-activity-path="${escAttr(item.activityPath)}"`
          : "";
        const clickHandler =
          item.kind === "tool"
            ? `showToolResult('${escAttr(item.activityPath)}', '${escAttr(item.agentId)}', ${item.index})`
            : `scrollToAgentMessage(this.dataset.agentId, Number(this.dataset.messageIndex))`;

        return `
                <div class="${itemClasses}" data-sidebar-item-kind="${escAttr(item.kind)}" data-agent-id="${escAttr(item.agentId)}" data-message-index="${item.index}" data-index="${item.parentIndex}"${activityAttr} onclick="${clickHandler}">
                    <div class="message-item-header">
                        <span class="role-badge ${item.role}">${item.role}</span>
                        <span class="message-time">${formatTime(item.time)}</span>
                    </div>
                    <div class="message-preview">${previewHtml}</div>
                </div>
            `;
      })
      .join("");

  restoreSidebarAgentFilterScroll();
  restoreSidebarActiveState();
}

function restoreSidebarActiveState() {
  if (sidebarNavigationLock?.kind === "activity") {
    setActiveSidebarActivity(sidebarNavigationLock.activityPath);
  } else if (sidebarNavigationLock?.kind === "agent-message") {
    setActiveSidebarAgentMessage(
      sidebarNavigationLock.agentId,
      sidebarNavigationLock.messageIndex,
    );
  }
}

// Update the filter clear button and label state
function renderFilterIndicator() {
  const label = document.getElementById("filterLabel");
  const clearBtn = document.getElementById("filterClear");
  const hasFilter = filterQuery || urlSearchQuery;

  clearBtn.disabled = !hasFilter;

  if (urlSearchQuery && !filterQuery) {
    label.textContent = `Filtered by: "${esc(urlSearchQuery)}"`;
    label.style.display = "block";
  } else {
    label.style.display = "none";
  }
}

// Clear all active filters (typed input and URL-driven)
function clearFilter() {
  filterQuery = "";
  document.getElementById("filterBox").value = "";

  if (urlSearchQuery) {
    urlSearchQuery = "";
    const url = new URL(window.location);
    url.searchParams.delete("q");
    window.history.replaceState({}, "", url);
  }

  renderFilterIndicator();
  renderSidebar();
  renderTimeline();
}

function messageMatchesSearch(msg, activeSearch, subagents) {
  if (!activeSearch) return false;
  return getMessageSearchText(msg, subagents)
    .toLowerCase()
    .includes(activeSearch.toLowerCase());
}

function shouldShowMessageInTranscriptList(msg, activeSearch, subagents) {
  const hasSubagent = messageHasSubagentTranscript(msg, subagents);
  const matchesSearch = messageMatchesSearch(msg, activeSearch, subagents);
  if (currentFilter !== "all" && msg.role !== currentFilter) return false;

  if (
    hideIntermediateSteps &&
    isIntermediateStep(msg) &&
    !hasSubagent &&
    !matchesSearch
  ) {
    return false;
  }

  const preview = getPreview(msg);
  if (/^\[.*?\]$/.test(preview.trim()) && !hasSubagent && !matchesSearch) {
    return false;
  }

  if (activeSearch && !matchesSearch) return false;
  return true;
}

function shouldShowMessageInSidebar(msg, activeSearch, subagents) {
  if (activeSearch && messageMatchesSearch(msg, activeSearch, subagents)) {
    return true;
  }
  if (
    isIntermediateStep(msg) &&
    !messageHasSubagentTranscript(msg, subagents)
  ) {
    return false;
  }
  return true;
}

function hasRecordedToolResult(part) {
  const state = part?.state || {};
  if (!state || typeof state !== "object") return false;
  return state.output !== undefined || state.error !== undefined;
}

function getToolResultSidebarPreview(part) {
  const toolName = part.tool || "tool";
  const state = part.state || {};
  const title = state.title || state.status || toolName;
  return compactText(`Tool result (${toolName}): ${title}`);
}

function buildSidebarToolItems(msg, track, messageIndex, parentIndex) {
  const subagentPathSegments =
    track.id === "main" ? [] : [...track.pathSegments, `msg${messageIndex}`];

  return (msg.parts || [])
    .map((part, partIndex) => {
      if (part.type !== "tool" || !hasRecordedToolResult(part)) return null;

      const activityPath = getToolActivityPath(part, {
        parentIndex,
        subagentPathSegments,
        partIndex,
      });
      if (!expandedToolResults.has(activityPath)) return null;

      const preview = getToolResultSidebarPreview(part);
      return {
        kind: "tool",
        agentId: track.id,
        role: "tool",
        time: part.time_created || msg.time_created,
        preview,
        text: getToolText(part) || preview,
        index: messageIndex,
        parentIndex,
        activityPath,
      };
    })
    .filter(Boolean);
}

function buildSidebarItems(activeSearch) {
  const items = [];
  const track = ensureSelectedAgentTrack();
  if (!track) return items;
  const subagents = track.subagents || [];

  track.messages.forEach((msg, index) => {
    const showMessage = shouldShowMessageInTranscriptList(
      msg,
      activeSearch,
      subagents,
    );
    if (showMessage) {
      const parentIndex = track.id === "main" ? index : track.parentIndex || 0;
      if (shouldShowMessageInSidebar(msg, activeSearch, subagents)) {
        items.push({
          kind: "message",
          agentId: track.id,
          role: msg.role,
          time: msg.time_created,
          preview: getPreview(msg),
          text: getMessageSearchText(msg, subagents) || getPreview(msg),
          index,
          parentIndex,
        });
      }
      items.push(...buildSidebarToolItems(msg, track, index, parentIndex));
    }
  });

  return items;
}

function buildMessageToolActivities(msg, context) {
  const activities = [];

  (msg.parts || []).forEach((part, partIndex) => {
    if (part.type !== "tool") return;

    const transcript =
      part.tool === "task"
        ? getSubagentTranscriptForPart(part, context.subagents)
        : null;
    const activityPath = getToolActivityPath(part, {
      ...context,
      partIndex,
    });

    activities.push({
      kind: "tool",
      activityPath,
      parentIndex: context.parentIndex,
      parentActivityPath: context.parentActivityPath || "",
      sourcePartIndex: partIndex,
      sourcePartId: part?.id || "",
      linkedSubagentPath: getLinkedSubagentPath(part, transcript, {
        ...context,
        partIndex,
      }),
      part,
    });
  });

  return activities;
}

function getSidebarMatchSnippet(item, query) {
  const text = item.text || item.preview || "";
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex === -1) return item.preview;

  const contextSize = 100;
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + query.length + contextSize);

  let snippet = text.substring(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet += "...";
  return snippet;
}

function renderToolActivityLink(activityPath, context = {}) {
  if (!activityPath) return "";
  const expanded = expandedToolResults.has(activityPath);
  const agentArg = context.agentId ? `, '${escAttr(context.agentId)}'` : "";
  const messageIndex =
    context.messageIndex === null || context.messageIndex === undefined
      ? ""
      : `, ${context.messageIndex}`;
  const buttonLabel = expanded ? "hide result" : "tool result";
  return `<button type="button" class="activity-link" onclick="toggleToolResult('${escAttr(activityPath)}'${agentArg}${messageIndex})" aria-expanded="${expanded ? "true" : "false"}" data-tool-result-button="${escAttr(activityPath)}">${esc(buttonLabel)}</button>`;
}

function renderSubagentActivityLink(activityPath) {
  if (!activityPath) return "";
  return `<button type="button" class="activity-link" onclick="scrollToAgentMessage('${escAttr(activityPath)}', 0)">subagent stream</button>`;
}

function renderToolReference(part, context = {}) {
  const st = part.state || {};
  const transcript =
    part.tool === "task"
      ? getSubagentTranscriptForPart(part, context.subagents)
      : null;
  const activityPath = getToolActivityPath(part, context);
  const linkedSubagentPath = getLinkedSubagentPath(part, transcript, context);
  const summary = context.intermediateStep
    ? st.title || ""
    : st.title || getToolPreview(part).replace(/^Tool \([^)]+\):?\s*/, "");
  const status =
    st.status || (st.error ? "error" : st.output ? "completed" : "");
  const spawnAttrs = linkedSubagentPath
    ? ` id="${getSpawnPromptDomId(linkedSubagentPath)}" data-spawns-agent-id="${escAttr(linkedSubagentPath)}"`
    : "";

  return `
        <div class="part part-activity-ref tool-ref"${spawnAttrs} data-activity-path="${escAttr(activityPath)}" data-linked-subagent-path="${escAttr(linkedSubagentPath)}">
            <div class="activity-ref-main">
                <span class="activity-ref-kind">tool</span>
                <span class="activity-ref-title">${esc(part.tool || "tool")}</span>
                ${summary ? `<span class="activity-ref-summary">${esc(compactText(summary, 160))}</span>` : ""}
                ${status ? `<span class="activity-ref-status">${esc(status)}</span>` : ""}
            </div>
            <div class="activity-ref-actions">
                ${renderToolActivityLink(activityPath, context)}
                ${linkedSubagentPath ? renderSubagentActivityLink(linkedSubagentPath) : ""}
            </div>
        </div>
    `;
}

function renderToolSections(part) {
  const st = part.state || {};
  const inputText = st.input ? JSON.stringify(st.input, null, 2) : "";
  const outputText = stringifyValue(st.output);
  const errorText = stringifyValue(st.error);
  const toolName = (part.tool || "").toLowerCase();
  const noHighlightTools = [
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "mcp_read",
    "mcp_write",
    "mcp_edit",
    "mcp_glob",
    "mcp_grep",
  ];
  const skipHighlight = noHighlightTools.some((t) => toolName.includes(t));
  const inputLangClass = skipHighlight ? "" : "language-json";

  return `
        ${
          inputText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Input</div>
                <pre class="tool-code"><code class="${inputLangClass}">${esc(inputText)}</code></pre>
            </div>
        `
            : ""
        }
        ${
          outputText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Output</div>
                <pre class="tool-code"><code>${esc(outputText)}</code></pre>
            </div>
        `
            : ""
        }
        ${
          errorText
            ? `
            <div class="tool-section">
                <div class="tool-section-label">Error</div>
                <pre class="tool-code"><code>${esc(errorText)}</code></pre>
            </div>
        `
            : ""
        }
    `;
}

function renderToolActivity(activity) {
  const part = activity.part;
  const st = part.state || {};
  const title = st.title || getToolPreview(part);
  const linkedSubagent = activity.linkedSubagentPath
    ? renderSubagentActivityLink(activity.linkedSubagentPath)
    : "";
  const expanded = expandedToolResults.has(activity.activityPath);

  return `
        <section class="activity-card tool-activity inline-tool-result ${expanded ? "expanded" : ""}" id="${getActivityDomId(activity.activityPath)}" data-activity-kind="tool" data-activity-path="${escAttr(activity.activityPath)}" data-parent-message-index="${activity.parentIndex}" data-source-part-index="${activity.sourcePartIndex}" data-source-part-id="${escAttr(activity.sourcePartId)}" data-parent-activity-path="${escAttr(activity.parentActivityPath || "")}" data-linked-subagent-path="${escAttr(activity.linkedSubagentPath || "")}" aria-hidden="${expanded ? "false" : "true"}">
            <div class="activity-card-header">
                <div class="activity-title-row">
                    <span class="activity-kind tool">tool</span>
                    <span class="activity-title">${esc(part.tool || "tool")}</span>
                    ${st.status ? `<span class="tool-status">${esc(st.status)}</span>` : ""}
                </div>
                ${linkedSubagent}
            </div>
            <div class="activity-relation">
                <span>result for message ${activity.parentIndex + 1}</span>
                <span>part ${activity.sourcePartIndex + 1}</span>
                ${activity.parentActivityPath ? `<span>inside ${esc(activity.parentActivityPath)}</span>` : ""}
            </div>
            ${title ? `<div class="activity-summary">${esc(compactText(title, 240))}</div>` : ""}
            <div class="activity-card-body tool-body expanded" id="tool-body-${domId(activity.activityPath)}">
                ${renderToolSections(part) || '<div class="subagent-empty">No tool result recorded.</div>'}
            </div>
        </section>
    `;
}

function renderInlineToolResults(activities) {
  if (!activities.length) return "";
  return `
        <div class="inline-tool-results">
            ${activities.map((activity) => renderToolActivity(activity)).join("")}
        </div>
    `;
}

function renderMarkdownSegment(text) {
  if (!text) return "";
  return DOMPurify.sanitize(marked.parse(text));
}

function getClaudeCodeBlockKind(block) {
  return block.match(/^<([a-zA-Z][a-zA-Z0-9_-]*)\b/)?.[1] || "block";
}

function renderClaudeCodeBlock(block) {
  const kind = getClaudeCodeBlockKind(block);
  const label = kind
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return `
        <figure class="claude-code-block" data-claude-code-block="${escAttr(kind)}">
            <figcaption>Claude Code ${esc(label)}</figcaption>
            <pre><code class="language-xml">${esc(block)}</code></pre>
        </figure>
    `;
}

function renderAssistantText(text) {
  const blockPattern =
    /<path>[\s\S]*?<\/content>|<(task|task_result|shell_metadata|skill_content|system-reminder)\b[\s\S]*?<\/\1>/gi;
  let html = "";
  let lastIndex = 0;
  let match;

  while ((match = blockPattern.exec(text)) !== null) {
    html += renderMarkdownSegment(text.slice(lastIndex, match.index));
    html += renderClaudeCodeBlock(match[0]);
    lastIndex = match.index + match[0].length;
  }

  html += renderMarkdownSegment(text.slice(lastIndex));
  return html;
}

// Render part
function renderPart(part, context = {}) {
  if (part.type === "reasoning" && part.text) {
    const content = renderMarkdownSegment(part.text);
    return `
            <details class="part part-reasoning" data-reasoning-collapsed="true">
                <summary class="reasoning-label">Thinking Process</summary>
                <div class="part-text">${content}</div>
            </details>
        `;
  }

  if (part.type === "text" && part.text) {
    // Skip synthetic text parts (these are tool call echoes that shouldn't be rendered as text)
    if (part.synthetic) {
      return "";
    }
    const cleanHtml =
      context.role === "assistant"
        ? renderAssistantText(part.text)
        : renderMarkdownSegment(part.text);
    return `<div class="part"><div class="part-text">${cleanHtml}</div></div>`;
  }

  if (part.type === "tool") {
    return renderToolReference(part, context);
  }

  if (part.type === "step-start") {
    return `<div class="part part-step">▶ Step started</div>`;
  }

  if (part.type === "step-finish") {
    const t = part.tokens || {};
    return `
            <div class="part part-step">
                ✓ Step finished (${part.reason || ""})
                ${t.input ? `<span class="token-badge">In: ${t.input.toLocaleString()}</span>` : ""}
                ${t.output ? `<span class="token-badge">Out: ${t.output.toLocaleString()}</span>` : ""}
                ${t.cache?.read ? `<span class="token-badge">Cache: ${t.cache.read.toLocaleString()}</span>` : ""}
            </div>
        `;
  }

  return "";
}

function renderAgentConnector(track) {
  if (track.kind !== "subagent" || track.unlinked) return "";
  if (
    track.sourceMessageIndex === null ||
    track.sourceMessageIndex === undefined
  ) {
    return "";
  }

  const parentAgentId = track.parentAgentId || "main";
  const sourceMessageId = getAgentMessageDomId(
    parentAgentId,
    track.sourceMessageIndex,
  );
  const spawnPromptId = getSpawnPromptDomId(track.id);
  const firstMessageId = track.messages.length
    ? getAgentMessageDomId(track.id, 0)
    : "";
  const promptText = track.spawnPrompt || "Task prompt";

  return `
        <div class="agent-connector" aria-label="Pinned subagent relationship" data-source-agent-id="${escAttr(parentAgentId)}" data-source-message-id="${escAttr(sourceMessageId)}" data-spawn-prompt-id="${escAttr(spawnPromptId)}" data-first-message-id="${escAttr(firstMessageId)}" data-subagent-id="${escAttr(track.id)}">
            <button type="button" class="agent-connector-node parent" onclick="scrollToAgentMessage('${escAttr(parentAgentId)}', ${track.sourceMessageIndex})">
                <span class="agent-connector-label">parent message</span>
                <span class="agent-connector-value">${track.sourceMessageIndex + 1}</span>
            </button>
            <button type="button" class="agent-connector-node prompt" title="${escAttr(promptText)}" onclick="scrollToDomId('${escAttr(spawnPromptId)}', { kind: 'spawn-prompt', agentId: '${escAttr(track.id)}' })">
                <span class="agent-connector-label">spawn prompt</span>
                <span class="agent-connector-value">view</span>
            </button>
            <button type="button" class="agent-connector-node first" onclick="scrollToAgentMessage('${escAttr(track.id)}', 0)">
                <span class="agent-connector-label">first message</span>
                <span class="agent-connector-value">${track.messages.length ? "1" : "none"}</span>
            </button>
        </div>
    `;
}

function renderAlignmentSpacer(track) {
  if (track.kind !== "subagent") return "";

  return `
        <div class="agent-alignment-spacer" data-align-agent-id="${escAttr(track.id)}" data-alignment-offset-px="0" style="height:0px"></div>
    `;
}

function renderAgentMessage(msg, track, messageIndex) {
  const messageId = getAgentMessageDomId(track.id, messageIndex);
  const parentIndex =
    track.id === "main" ? messageIndex : track.parentIndex || 0;
  const messageModel = getMessageModelId(msg);
  const subagentPathSegments =
    track.id === "main" ? [] : [...track.pathSegments, `msg${messageIndex}`];
  const toolContext = {
    subagents: track.subagents || [],
    parentIndex,
    partIndex: null,
    subagentPathSegments,
    parentActivityPath: track.id === "main" ? "" : track.id,
  };
  const toolActivities = buildMessageToolActivities(msg, toolContext);
  const copyButton =
    track.id === "main"
      ? `
                        <button class="copy-btn" onclick="copyMarkdown(${messageIndex})" title="Copy markdown to clipboard">
                            <span>📋</span> Copy
                        </button>
        `
      : "";

  return `
                <div class="agent-message-group" data-agent-id="${escAttr(track.id)}" data-message-index="${messageIndex}">
                    <div class="message ${msg.role} agent-track-message" id="${messageId}" data-agent-id="${escAttr(track.id)}" data-message-index="${messageIndex}" data-parent-message-index="${parentIndex}">
                        <div class="message-header">
                            <div class="message-header-left">
                                <span class="role-badge ${msg.role}">${msg.role}</span>
                                <span class="message-meta">
                                    <span>${formatFullTime(msg.time_created)}</span>
                                    ${track.kind === "main" && messageModel ? `<span>${esc(messageModel)}</span>` : ""}
                                    ${msg.agent ? `<span>${esc(msg.agent)}</span>` : ""}
                                </span>
                            </div>
                            ${copyButton}
                        </div>
                        <div class="message-body">
                            ${
                              (msg.parts || [])
                                .map((p, partIndex) =>
                                  renderPart(p, {
                                    ...toolContext,
                                    agentId: track.id,
                                    intermediateStep: isIntermediateStep(msg),
                                    role: msg.role,
                                    messageIndex,
                                    partIndex,
                                  }),
                                )
                                .join("") ||
                              '<span style="color:var(--text-tertiary)">(no content)</span>'
                            }
                        </div>
                    </div>
                    ${renderInlineToolResults(toolActivities)}
                </div>
            `;
}

function renderAgentTrack(track, activeSearch, options = {}) {
  const subagents = track.subagents || [];
  const visibleMessages = track.messages
    .map((msg, index) => {
      if (!shouldShowMessageInTranscriptList(msg, activeSearch, subagents)) {
        return "";
      }

      return renderAgentMessage(msg, track, index);
    })
    .join("");
  const active = track.id === selectedAgentId;
  const title = getAgentTitle(track);
  const model = getTrackModel(track);
  const isPanel = options.variant === "panel";
  const trackClasses = [
    "agent-track",
    active ? "active" : "",
    track.kind === "main" ? "agent-main-stream" : "",
    isPanel ? "subagent-panel" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `
        <section class="${trackClasses}" id="agent-track-${domId(track.id)}" data-agent-id="${escAttr(track.id)}" data-track-kind="${escAttr(track.kind)}" data-panel-open="${isPanel ? "true" : "false"}">
            <div class="agent-track-header">
                <div class="agent-track-titlebar">
                    <div class="agent-track-heading">
                        <div class="agent-track-kicker">${track.kind === "main" ? "main agent" : track.unlinked ? "unlinked subagent" : "subagent"}</div>
                    </div>
                    <div class="agent-track-actions">
                        ${track.kind === "subagent" && model ? `<div class="agent-track-model" data-track-model="${escAttr(model)}">${esc(model)}</div>` : ""}
                        <div class="agent-track-meta">${track.messages.length} message${track.messages.length === 1 ? "" : "s"}</div>
                        ${isPanel ? `<button type="button" class="agent-panel-close" aria-label="Close ${escAttr(title)}" onclick="closeSubagentPanel('${escAttr(track.id)}', event)">×</button>` : ""}
                    </div>
                </div>
                <div class="agent-track-title" title="${escAttr(title)}">${esc(title)}</div>
                ${renderAgentConnector(track)}
            </div>
            <div class="agent-track-body">
                ${visibleMessages ? renderAlignmentSpacer(track) + visibleMessages : '<div class="agent-track-empty">No messages match the current filters.</div>'}
                <div class="agent-stream-height-spacer" data-agent-id="${escAttr(track.id)}" aria-hidden="true"></div>
            </div>
        </section>
    `;
}

function alignSubagentTracks() {
  const spacers = Array.from(
    document.querySelectorAll(".agent-alignment-spacer"),
  );
  spacers.forEach((spacer) => {
    spacer.style.height = "0px";
    spacer.style.marginTop = "0px";
    spacer.dataset.alignmentOffsetPx = "0";
    spacer.dataset.alignmentStatus = "pending";
    spacer.classList.remove("unlinked");
    spacer.classList.remove("clamped");
  });

  // Force layout after resetting heights so nested tracks measure parent
  // messages after their parent track has been aligned in DOM order.
  void document.body.offsetHeight;

  document
    .querySelectorAll('.agent-track[data-track-kind="subagent"]')
    .forEach((track) => {
      const spacer = track.querySelector(
        ":scope > .agent-track-body > .agent-alignment-spacer",
      );
      if (!spacer) return;

      const connector = track.querySelector(".agent-connector");
      const parentMessageId = connector?.dataset.sourceMessageId || "";
      const firstMessageId = connector?.dataset.firstMessageId || "";
      const parentMessage = document.getElementById(parentMessageId);
      const firstMessage = document.getElementById(firstMessageId);

      if (!connector || !parentMessage || !firstMessage) {
        spacer.dataset.alignmentStatus = "unlinked";
        spacer.classList.add("unlinked");
        return;
      }

      const parentTop = parentMessage.getBoundingClientRect().top;
      const firstTop = firstMessage.getBoundingClientRect().top;
      const offsetPx = parentTop - firstTop;
      const connectorHeight = connector.getBoundingClientRect().height;

      if (offsetPx >= 0) {
        spacer.style.height = `${offsetPx.toFixed(1)}px`;
        spacer.style.marginTop = "0px";
        spacer.dataset.alignmentStatus = "aligned";
      } else {
        spacer.style.height = "0px";
        spacer.style.marginTop = "0px";
        spacer.dataset.alignmentStatus = "clamped";
        spacer.classList.add("clamped");
      }
      spacer.dataset.alignmentOffsetPx = offsetPx.toFixed(1);
      spacer.dataset.connectorHeightPx = connectorHeight.toFixed(1);
      spacer.dataset.parentMessageId = parentMessageId;
      spacer.dataset.firstMessageId = firstMessageId;
    });
}

function scheduleSubagentAlignment() {
  if (alignmentFrame !== null) {
    cancelAnimationFrame(alignmentFrame);
  }

  alignmentFrame = requestAnimationFrame(() => {
    alignmentFrame = null;
    alignSubagentTracks();
    scheduleAgentStreamHeightSync();
  });
}

function getAgentStreamScrollTargets() {
  const mainContent = document.getElementById("mainContent");
  const mainTrack = document.querySelector(".agent-main-stream");
  const targets = [];

  if (mainContent && mainTrack) {
    targets.push({ scrollElement: mainContent, track: mainTrack });
  }

  getSubagentPanelElements().forEach((panel) => {
    targets.push({ scrollElement: panel, track: panel });
  });

  return targets;
}

function syncAgentStreamHeights() {
  const spacers = Array.from(
    document.querySelectorAll(".agent-stream-height-spacer"),
  );
  spacers.forEach((spacer) => {
    spacer.style.height = "0px";
    spacer.dataset.streamHeightSpacerPx = "0";
    spacer.dataset.unifiedScrollRangePx = "0";
  });

  void document.body.offsetHeight;

  const targets = getAgentStreamScrollTargets();
  if (!targets.length) return;

  const maxScrollRange = Math.max(
    0,
    ...targets.map(({ scrollElement }) =>
      Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
    ),
  );

  targets.forEach(({ scrollElement, track }) => {
    const spacer = track.querySelector(".agent-stream-height-spacer");
    if (!spacer) return;

    const currentRange = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight,
    );
    const missingRange = Math.max(0, maxScrollRange - currentRange);
    spacer.style.height = `${missingRange.toFixed(1)}px`;
    spacer.dataset.streamHeightSpacerPx = missingRange.toFixed(1);
    spacer.dataset.unifiedScrollRangePx = maxScrollRange.toFixed(1);
  });
}

function scheduleAgentStreamHeightSync() {
  if (streamHeightFrame !== null) {
    cancelAnimationFrame(streamHeightFrame);
  }

  streamHeightFrame = requestAnimationFrame(() => {
    streamHeightFrame = null;
    syncAgentStreamHeights();
    syncSubagentPanelsToMain();
  });
}

function getSubagentPanelElements() {
  return Array.from(document.querySelectorAll(".subagent-panel"));
}

function syncSubagentPanelsToMain() {
  const mainContent = document.getElementById("mainContent");
  if (!mainContent || isSyncingAgentScroll) return;
  if (Date.now() < suppressMainPanelSyncUntil) return;

  isSyncingAgentScroll = true;
  try {
    const nextScrollTop = mainContent.scrollTop;
    getSubagentPanelElements().forEach((panel) => {
      if (panel.scrollTop !== nextScrollTop) {
        panel.scrollTop = nextScrollTop;
      }
    });
  } finally {
    isSyncingAgentScroll = false;
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function restoreSubagentPanelRackWidthOverride() {
  if (subagentPanelRackWidthOverride !== null) return;
  try {
    const savedWidth = Number(
      localStorage.getItem(SUBAGENT_PANEL_RACK_WIDTH_KEY),
    );
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      subagentPanelRackWidthOverride = savedWidth;
    }
  } catch (error) {
    subagentPanelRackWidthOverride = null;
  }
}

function getGoldenRatioMainMinWidth(wrapperWidth, configuredMinWidth) {
  if (!wrapperWidth) return configuredMinWidth;
  return wrapperWidth / (GOLDEN_RATIO + 1);
}

function getGoldenRatioMainMaxWidth(mainContentWidth) {
  if (!mainContentWidth) return 0;
  return mainContentWidth / GOLDEN_RATIO;
}

function updateMainStreamMaxWidth(
  wrapper = document.querySelector(".main-wrapper"),
) {
  if (!wrapper) return;

  const styles = window.getComputedStyle(wrapper);
  const rackWidth =
    parseFloat(styles.getPropertyValue("--subagent-panel-rack-width")) || 0;
  const wrapperWidth =
    wrapper.clientWidth || wrapper.getBoundingClientRect().width || 0;
  const mainContentAreaWidth = Math.max(0, wrapperWidth - rackWidth);
  const mainMaxWidth = getGoldenRatioMainMaxWidth(mainContentAreaWidth);

  if (Number.isFinite(mainMaxWidth) && mainMaxWidth > 0) {
    wrapper.style.setProperty(
      "--main-stream-max-width",
      `${mainMaxWidth.toFixed(1)}px`,
    );
  } else {
    wrapper.style.removeProperty("--main-stream-max-width");
  }
}

function getSubagentPanelOverlayMetrics(overlay, openPanelCount) {
  const wrapper = overlay.closest(".main-wrapper");
  const wrapperWidth = wrapper?.clientWidth || overlay.clientWidth || 0;
  const styles = window.getComputedStyle(wrapper || overlay);
  const panelWidth =
    parseFloat(styles.getPropertyValue("--subagent-panel-width")) || 520;
  const panelMinWidth =
    parseFloat(styles.getPropertyValue("--subagent-panel-min-width")) || 320;
  const panelGap =
    parseFloat(styles.getPropertyValue("--agent-stream-panel-gap")) || 16;
  const configuredMainMinWidth =
    parseFloat(styles.getPropertyValue("--main-stream-min-width")) || 420;

  if (!openPanelCount || !wrapperWidth) return null;

  const mainMinWidth = getGoldenRatioMainMinWidth(
    wrapperWidth,
    configuredMainMinWidth,
  );
  const layoutableWidth = Math.max(0, wrapperWidth - mainMinWidth);
  const targetWidth =
    openPanelCount * panelWidth + Math.max(0, openPanelCount - 1) * panelGap;
  const hasPanelOverflow = targetWidth > layoutableWidth;
  const canLayoutPanel = layoutableWidth >= panelMinWidth;
  const canResizePanels = hasPanelOverflow && canLayoutPanel;
  const maxWidth = layoutableWidth;
  const minWidth = Math.min(panelMinWidth, maxWidth);

  return {
    wrapper,
    wrapperWidth,
    panelGap,
    panelMinWidth,
    configuredMainMinWidth,
    mainMinWidth,
    canLayoutPanel,
    hasPanelOverflow,
    canResizePanels,
    layoutableWidth,
    targetWidth,
    minWidth,
    maxWidth,
  };
}

function updateSubagentPanelLayoutReadyState(overlay, metrics) {
  const canLayoutPanel = Boolean(metrics?.canLayoutPanel);
  const hasPanelOverflow = Boolean(metrics?.hasPanelOverflow);
  const canResizePanels = Boolean(metrics?.canResizePanels);
  const wrapper = overlay.closest(".main-wrapper");
  overlay.dataset.layoutReady = canLayoutPanel ? "true" : "false";
  overlay.dataset.panelOverflow = hasPanelOverflow ? "true" : "false";
  overlay.dataset.panelResizable = canResizePanels ? "true" : "false";
  if (wrapper) {
    wrapper.dataset.subagentPanelLayoutReady = canLayoutPanel
      ? "true"
      : "false";
    wrapper.dataset.subagentPanelOverflow = hasPanelOverflow ? "true" : "false";
    wrapper.dataset.subagentPanelResizable = canResizePanels ? "true" : "false";
    if (Number.isFinite(metrics?.mainMinWidth)) {
      wrapper.style.setProperty(
        "--main-stream-min-width",
        `${metrics.mainMinWidth.toFixed(1)}px`,
      );
    } else {
      wrapper.style.removeProperty("--main-stream-min-width");
    }
  }
}

function updateSubagentSeparatorState(overlay, width, metrics) {
  const separator = overlay
    .closest(".main-wrapper")
    ?.querySelector(".agent-stream-separator");
  if (!separator || !metrics) return;

  if (!metrics.canResizePanels) {
    separator.removeAttribute("aria-valuemin");
    separator.removeAttribute("aria-valuemax");
    separator.removeAttribute("aria-valuenow");
    separator.removeAttribute("aria-valuetext");
    return;
  }

  separator.setAttribute("aria-valuemin", String(Math.round(metrics.minWidth)));
  separator.setAttribute("aria-valuemax", String(Math.round(metrics.maxWidth)));
  separator.setAttribute("aria-valuenow", String(Math.round(width)));
  separator.setAttribute(
    "aria-valuetext",
    `Sub-agent panels ${Math.round(width)} pixels wide`,
  );
}

function updateSubagentPanelOverlayWidth(overlay, openPanelCount) {
  const metrics = getSubagentPanelOverlayMetrics(overlay, openPanelCount);
  updateSubagentPanelLayoutReadyState(overlay, metrics);
  const wrapper = metrics?.wrapper || overlay.closest(".main-wrapper");

  if (!metrics) {
    overlay.style.setProperty("--subagent-panel-rack-width", "0px");
    wrapper?.style.setProperty("--subagent-panel-rack-width", "0px");
    updateMainStreamMaxWidth(wrapper);
    return;
  }

  const hasManualWidth = Number.isFinite(subagentPanelRackWidthOverride);
  const nextWidth = metrics.canLayoutPanel
    ? metrics.canResizePanels && hasManualWidth
      ? clamp(
          subagentPanelRackWidthOverride,
          metrics.minWidth,
          metrics.maxWidth,
        )
      : Math.min(metrics.maxWidth, metrics.targetWidth)
    : 0;
  if (hasManualWidth && metrics.canResizePanels) {
    subagentPanelRackWidthOverride = nextWidth;
  }
  overlay.style.setProperty(
    "--subagent-panel-rack-width",
    `${nextWidth.toFixed(1)}px`,
  );
  wrapper?.style.setProperty(
    "--subagent-panel-rack-width",
    `${nextWidth.toFixed(1)}px`,
  );
  updateMainStreamMaxWidth(wrapper);
  updateSubagentSeparatorState(overlay, nextWidth, metrics);
}

function persistSubagentPanelRackWidthOverride() {
  if (!Number.isFinite(subagentPanelRackWidthOverride)) return;
  try {
    localStorage.setItem(
      SUBAGENT_PANEL_RACK_WIDTH_KEY,
      String(Math.round(subagentPanelRackWidthOverride)),
    );
  } catch (error) {
    // Ignore storage failures; resizing should still work for the current page.
  }
}

function setSubagentPanelRackWidthOverride(width, options = {}) {
  const overlay = document.getElementById("subagentPanelOverlay");
  if (!overlay) return null;

  const openPanelCount = Number(overlay.dataset.openPanelCount || 0);
  const metrics = getSubagentPanelOverlayMetrics(overlay, openPanelCount);
  if (!metrics?.canResizePanels) {
    return null;
  }

  const nextWidth = clamp(width, metrics.minWidth, metrics.maxWidth);
  subagentPanelRackWidthOverride = nextWidth;
  updateSubagentPanelOverlayWidth(overlay, openPanelCount);

  if (options.persist) {
    persistSubagentPanelRackWidthOverride();
  }

  scheduleSubagentAlignment();
  return nextWidth;
}

function startSubagentSeparatorResize(event) {
  if (event.button !== undefined && event.button !== 0) return;

  const overlay = document.getElementById("subagentPanelOverlay");
  const openPanelCount = Number(overlay?.dataset.openPanelCount || 0);
  const metrics = overlay
    ? getSubagentPanelOverlayMetrics(overlay, openPanelCount)
    : null;
  if (!overlay || !metrics?.canResizePanels) return;

  event.preventDefault();
  event.stopPropagation();

  const separator = event.currentTarget;
  subagentSeparatorResizeState = {
    pointerId: event.pointerId,
    moveEventName: event.type === "mousedown" ? "mousemove" : "pointermove",
    endEventName: event.type === "mousedown" ? "mouseup" : "pointerup",
    cancelEventName:
      event.type === "mousedown" ? "mouseleave" : "pointercancel",
    startX: event.clientX,
    startWidth: overlay.getBoundingClientRect().width,
    separator,
  };

  separator.classList.add("dragging");
  separator.setAttribute("aria-grabbed", "true");
  if (event.pointerId !== undefined) {
    separator.setPointerCapture?.(event.pointerId);
  }
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  document.addEventListener(
    subagentSeparatorResizeState.moveEventName,
    handleSubagentSeparatorResizeMove,
    { passive: false },
  );
  document.addEventListener(
    subagentSeparatorResizeState.endEventName,
    finishSubagentSeparatorResize,
  );
  document.addEventListener(
    subagentSeparatorResizeState.cancelEventName,
    finishSubagentSeparatorResize,
  );
}

function handleSubagentSeparatorResizeMove(event) {
  if (!subagentSeparatorResizeState) return;
  event.preventDefault();

  const deltaX = event.clientX - subagentSeparatorResizeState.startX;
  setSubagentPanelRackWidthOverride(
    subagentSeparatorResizeState.startWidth - deltaX,
    { persist: false },
  );
}

function finishSubagentSeparatorResize(event = null) {
  if (!subagentSeparatorResizeState) return;

  const { separator, pointerId, moveEventName, endEventName, cancelEventName } =
    subagentSeparatorResizeState;
  if (event?.clientX !== undefined) {
    const deltaX = event.clientX - subagentSeparatorResizeState.startX;
    setSubagentPanelRackWidthOverride(
      subagentSeparatorResizeState.startWidth - deltaX,
      { persist: false },
    );
  }

  persistSubagentPanelRackWidthOverride();
  separator?.classList.remove("dragging");
  separator?.removeAttribute("aria-grabbed");
  if (pointerId !== undefined) {
    separator?.releasePointerCapture?.(pointerId);
  }
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  document.removeEventListener(
    moveEventName,
    handleSubagentSeparatorResizeMove,
  );
  document.removeEventListener(endEventName, finishSubagentSeparatorResize);
  document.removeEventListener(cancelEventName, finishSubagentSeparatorResize);
  subagentSeparatorResizeState = null;
}

function handleSubagentSeparatorKeydown(event) {
  const overlay = document.getElementById("subagentPanelOverlay");
  const openPanelCount = Number(overlay?.dataset.openPanelCount || 0);
  const metrics = overlay
    ? getSubagentPanelOverlayMetrics(overlay, openPanelCount)
    : null;
  if (!overlay || !metrics?.canResizePanels) return;

  const currentWidth = overlay.getBoundingClientRect().width;
  const step = event.shiftKey ? 80 : 24;
  let nextWidth = null;

  if (event.key === "ArrowLeft") {
    nextWidth = currentWidth + step;
  } else if (event.key === "ArrowRight") {
    nextWidth = currentWidth - step;
  } else if (event.key === "Home") {
    nextWidth = metrics.maxWidth;
  } else if (event.key === "End") {
    nextWidth = metrics.minWidth;
  }

  if (nextWidth === null) return;
  event.preventDefault();
  event.stopPropagation();
  setSubagentPanelRackWidthOverride(nextWidth, { persist: true });
}

function bindSubagentSeparatorResize() {
  const separator = document.getElementById("agentStreamSeparator");
  if (!separator || separator.dataset.resizeBound === "true") return;

  separator.dataset.resizeBound = "true";
  separator.addEventListener("keydown", handleSubagentSeparatorKeydown);
  if (window.PointerEvent) {
    separator.addEventListener("pointerdown", startSubagentSeparatorResize, {
      passive: false,
    });
  } else {
    separator.addEventListener("mousedown", startSubagentSeparatorResize, {
      passive: false,
    });
  }
}

function renderFloatingSubagentPanels(openSubagentTracks, activeSearch) {
  const overlay = document.getElementById("subagentPanelOverlay");
  if (!overlay) return;
  const wrapper = overlay.closest(".main-wrapper");

  overlay.dataset.openPanelCount = String(openSubagentTracks.length);
  if (wrapper) {
    wrapper.dataset.openPanelCount = String(openSubagentTracks.length);
  }
  overlay.style.setProperty("--open-panel-count", openSubagentTracks.length);
  updateSubagentPanelOverlayWidth(overlay, openSubagentTracks.length);
  if (!openSubagentTracks.length) {
    overlay.innerHTML = "";
    return;
  }

  const panelsHtml = openSubagentTracks
    .map((track) => renderAgentTrack(track, activeSearch, { variant: "panel" }))
    .join("");
  overlay.innerHTML = `
        <div class="subagent-panel-rack" id="subagentPanelRack" aria-label="Open subagent panels">
            ${panelsHtml}
        </div>
    `;
  requestAnimationFrame(() => {
    updateSubagentPanelOverlayWidth(overlay, openSubagentTracks.length);
    const rack = document.getElementById("subagentPanelRack");
    if (rack) {
      scrollHorizontalContainerToRightEdge(rack);
    }
    syncSubagentPanelsToMain();
  });
}

function refreshResponsiveAgentLayout() {
  const overlay = document.getElementById("subagentPanelOverlay");
  if (!overlay) return;

  updateSubagentPanelOverlayWidth(
    overlay,
    Number(overlay.dataset.openPanelCount || 0),
  );
  scheduleSubagentAlignment();
}

// Render timeline
function renderTimeline() {
  if (!SESSION_DATA) return;

  const activeSearch = filterQuery || urlSearchQuery;
  const timeline = document.getElementById("timeline");
  const tracks = getAgentTracks();
  ensureSelectedAgentTrack(tracks);
  reconcileOpenSubagentPanels(tracks);

  const mainTrack = tracks.find((track) => track.id === "main") || tracks[0];
  const openSubagentTracks = getOpenSubagentTracks(tracks);

  timeline.innerHTML = `
        <div class="agent-workspace" id="agentWorkspace" data-open-panel-count="${openSubagentTracks.length}">
            ${renderAgentTrack(mainTrack, activeSearch, { variant: "main" })}
        </div>
    `;
  renderFloatingSubagentPanels(openSubagentTracks, activeSearch);

  // Apply syntax highlighting to all code blocks
  applySyntaxHighlighting();
  scheduleSubagentAlignment();
}

// Apply syntax highlighting to code blocks
function applySyntaxHighlighting() {
  // Find all code blocks inside pre elements that haven't been highlighted yet
  // Only highlight blocks that have a language class specified (e.g., language-javascript)
  document.querySelectorAll("pre code:not(.hljs)").forEach((block) => {
    // Check if the block has a language class
    const langClass = Array.from(block.classList).find((cls) =>
      cls.startsWith("language-"),
    );

    if (langClass) {
      const lang = langClass.replace("language-", "");
      // Only highlight if we have a valid language (not empty)
      if (lang && hljs.getLanguage(lang)) {
        hljs.highlightElement(block);
      }
    }
  });
}

// Update stats
function updateStats() {
  if (!SESSION_DATA) return;
  const total = SESSION_DATA.messages.length;
  const user = SESSION_DATA.messages.filter((m) => m.role === "user").length;
  const asst = SESSION_DATA.messages.filter(
    (m) => m.role === "assistant",
  ).length;
  const subagents = getAgentTracks().filter(
    (track) => track.kind === "subagent",
  ).length;
  document.getElementById("stats").innerHTML = `
        <span>${total} total</span>
        <span>${user} user</span>
        <span>${asst} assistant</span>
        ${subagents ? `<span>${subagents} subagents</span>` : ""}
    `;
}

// Load data
function loadData(data) {
  SESSION_DATA = data;
  bindSubagentSeparatorResize();

  // Initialize URL search query (passed in from dashboard search)
  urlSearchQuery = getUrlSearchQuery();
  if (urlSearchQuery) {
    // Pre-populate the filter box with the incoming query
    document.getElementById("filterBox").value = urlSearchQuery;
  }

  buildTokenData();
  updateStats();
  renderFilterIndicator();
  renderSidebar();
  renderTimeline();
  updateViz(0);

  // Add scroll listener
  const mainContent = document.getElementById("mainContent");
  if (!layoutResizeListenerBound) {
    layoutResizeListenerBound = true;
    window.addEventListener("resize", refreshResponsiveAgentLayout, {
      passive: true,
    });
  }
  mainContent.addEventListener("scroll", syncSubagentPanelsToMain, {
    passive: true,
  });
  mainContent.addEventListener("scroll", detectVisibleMessage);
  ["wheel", "touchstart", "pointerdown"].forEach((eventName) => {
    mainContent.addEventListener(eventName, clearSidebarNavigationLock, {
      passive: true,
    });
  });
  document.addEventListener("keydown", (event) => {
    if (
      [
        "ArrowUp",
        "ArrowDown",
        "PageUp",
        "PageDown",
        "Home",
        "End",
        " ",
      ].includes(event.key)
    ) {
      clearSidebarNavigationLock();
    }
  });

  // Navbar hide/show on scroll
  const navbar = document.getElementById("topNavbar");
  const container = document.querySelector(".container");
  let lastScrollTop = 0;
  mainContent.addEventListener("scroll", () => {
    const st = mainContent.scrollTop;
    if (st > lastScrollTop && st > 60) {
      // scrolling down — hide navbar, reclaim space
      navbar.classList.add("navbar-hidden");
      container.classList.add("navbar-hidden");
    } else {
      // scrolling up — show navbar
      navbar.classList.remove("navbar-hidden");
      container.classList.remove("navbar-hidden");
    }
    lastScrollTop = st;
  });

  // If there's a URL search query, scroll to first matching message
  if (urlSearchQuery) {
    const firstMatch = SESSION_DATA.messages.findIndex((m) => {
      const fullText = getFullText(m);
      return fullText.includes(urlSearchQuery.toLowerCase());
    });
    if (firstMatch !== -1) {
      setTimeout(() => scrollToMessage(firstMatch), 100);
    }
  }
}

// Archive functionality
let isArchived = false;

async function checkArchiveStatus() {
  if (!SESSION_DATA) return;
  try {
    const response = await fetch(
      `/api/conversation/${SESSION_DATA.summary.id}/archived`,
    );
    const data = await response.json();
    isArchived = data.archived;
    updateArchiveButton();
  } catch (e) {
    console.error("Failed to check archive status:", e);
  }
}

function updateArchiveButton() {
  const btn = document.getElementById("archiveBtn");
  if (isArchived) {
    btn.textContent = "Archived";
    btn.classList.add("archived");
    btn.title = "Unarchive this conversation";
  } else {
    btn.textContent = "Archive";
    btn.classList.remove("archived");
    btn.title = "Archive this conversation";
  }
}

async function toggleArchive() {
  if (!SESSION_DATA) return;

  const btn = document.getElementById("archiveBtn");
  btn.disabled = true;

  try {
    const action = isArchived ? "unarchive" : "archive";
    const response = await fetch(
      `/api/conversation/${SESSION_DATA.summary.id}/${action}`,
      {
        method: "POST",
      },
    );

    if (response.ok) {
      isArchived = !isArchived;
      updateArchiveButton();

      // If archiving, redirect to dashboard after a short delay
      if (isArchived) {
        btn.textContent = "Redirecting...";
        setTimeout(() => {
          window.location.href = "/";
        }, 500);
      }
    } else {
      console.error("Failed to toggle archive status");
    }
  } catch (e) {
    console.error("Failed to toggle archive:", e);
  } finally {
    btn.disabled = false;
  }
}

// Initialize everything when DOM is ready
function initConversation() {
  // Initialize sidebar resize
  initSidebarResize();
  restoreSubagentPanelRackWidthOverride();
  bindSubagentSeparatorResize();

  // Initialize viz panel state
  initVizPanel();

  // Set up filter buttons
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".filter-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderSidebar();
    });
  });

  // Set up filter input
  document.getElementById("filterBox").addEventListener("input", (e) => {
    filterQuery = e.target.value.toLowerCase();
    renderFilterIndicator();
    renderSidebar();
    renderTimeline();
  });

  // Set up intermediate assistant-step visibility toggle
  document
    .getElementById("hideIntermediateSteps")
    .addEventListener("change", (e) => {
      hideIntermediateSteps = e.target.checked;
      renderSidebar();
      renderTimeline();
    });

  // Resize handler for sparkline
  window.addEventListener("resize", () => {
    renderSparkline();
    scheduleSubagentAlignment();
  });

  // Load data from script tag
  try {
    const jsonText = document.getElementById("conversation-data").textContent;
    const INITIAL_DATA = JSON.parse(jsonText);
    if (INITIAL_DATA) {
      loadData(INITIAL_DATA);
      // Check archive status after loading
      checkArchiveStatus();
    }
  } catch (e) {
    console.error("Failed to parse conversation data:", e);
  }
}

// Run initialization when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initConversation);
} else {
  initConversation();
}
