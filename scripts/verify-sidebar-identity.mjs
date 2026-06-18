import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const conversationJs = fs.readFileSync(
  path.join(repoRoot, "app/static/js/conversation.js"),
  "utf8",
);
const conversationCss = fs.readFileSync(
  path.join(repoRoot, "app/static/css/conversation.css"),
  "utf8",
);

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function harnessHtml() {
  return `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${conversationCss}</style>
        <style>
          #mainContent { height: 720px; overflow: auto; }
          #messageList { width: 320px; }
          .agent-filter-option { flex: 0 0 auto; min-width: 180px; }
        </style>
        <script>
          window.marked = { setOptions() {}, parse(value) { return String(value || ""); } };
          window.DOMPurify = { sanitize(value) { return String(value || ""); } };
          window.hljs = { getLanguage() { return false; }, highlightElement() {} };
          window.localStorage = window.localStorage || { getItem() {}, setItem() {} };
        </script>
      </head>
      <body>
        <div id="topNavbar"></div>
        <div class="container">
          <aside id="sidebar"><div id="sidebarResizeHandle"></div></aside>
          <div id="messageList"></div>
          <div class="main-wrapper">
            <div id="mainContent" class="scroll-container">
              <div class="main-content">
                <div id="timeline" class="timeline"></div>
              </div>
            </div>
            <div
              id="agentStreamSeparator"
              class="agent-stream-separator"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize main agent and sub-agent panels"
              tabindex="0"
              title="Drag to resize main and sub-agent panels"
            ></div>
            <div id="subagentPanelOverlay" class="subagent-floating-panels"></div>
          </div>
          <div id="vizPanel"><button id="vizPanelToggle"></button></div>
        </div>
        <div id="stats"></div>
        <button class="filter-btn active" data-filter="all"></button>
        <button class="filter-btn" data-filter="user"></button>
        <button class="filter-btn" data-filter="assistant"></button>
        <input id="filterBox" />
        <input id="hideIntermediateSteps" type="checkbox" checked />
        <button id="filterClear"></button>
        <div id="filterLabel"></div>
        <div id="inputBar"></div>
        <div id="outputBar"></div>
        <div id="cacheBar"></div>
        <div id="inputValue"></div>
        <div id="outputValue"></div>
        <div id="cacheValue"></div>
        <div id="progressBar"></div>
        <div id="progressLabel"></div>
        <svg id="sparkline"></svg>
        <button id="archiveBtn"></button>
        <script id="conversation-data" type="application/json">null</script>
      </body>
    </html>`;
}

async function setupPage(browser, viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({
    viewport,
  });
  await page.setContent(harnessHtml(), { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: conversationJs });
  return page;
}

async function runSyntheticSession(page, data) {
  return page.evaluate(async (sessionData) => {
    hideIntermediateSteps = false;
    currentFilter = "all";
    filterQuery = "";
    urlSearchQuery = "";
    loadData(sessionData);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  }, data);
}

function duplicateIdsFrom(ids) {
  return Array.from(
    new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  );
}

function hasAlignedConnector(connector) {
  const resolvedWithoutOverlap =
    (connector.alignmentStatus === "clamped" &&
      connector.firstMessageTopDelta >= 0) ||
    (connector.alignmentStatus === "aligned" &&
      connector.firstMessageTopDelta >= 0 &&
      connector.firstMessageTopDelta <= 32);

  return (
    connector.sourceMessageExists &&
    connector.spawnPromptExists &&
    connector.firstMessageExists &&
    (connector.alignmentStatus === "aligned" || resolvedWithoutOverlap) &&
    connector.connectorHeight > 0 &&
    connector.alignmentConnectorHeight > 0 &&
    (resolvedWithoutOverlap || Math.abs(connector.firstMessageTopDelta) < 1)
  );
}

async function readIdentityState(page, selector) {
  return page.evaluate((rowSelector) => {
    const ids = Array.from(document.querySelectorAll("[id]")).map(
      (el) => el.id,
    );
    const rows = Array.from(document.querySelectorAll(rowSelector));
    const activeRows = Array.from(
      document.querySelectorAll(".message-item.active"),
    );
    const rectOf = (el) => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    };
    const scrollRangeOf = (el) =>
      el ? Math.max(0, el.scrollHeight - el.clientHeight) : null;
    return {
      duplicateIds: Array.from(
        new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
      ),
      rows: rows.map((el) => ({
        index: el.dataset.index || null,
        agentId: el.dataset.agentId || null,
        messageIndex: el.dataset.messageIndex || null,
        subagentId: el.dataset.subagentId || null,
        subagentIndex: el.dataset.subagentIndex || null,
        subagentPath: el.dataset.subagentPath || null,
        activityPath: el.dataset.activityPath || null,
        active: el.classList.contains("active"),
        text: el.textContent.replace(/\\s+/g, " ").trim(),
      })),
      activeRows: activeRows.map((el) => ({
        index: el.dataset.index || null,
        agentId: el.dataset.agentId || null,
        messageIndex: el.dataset.messageIndex || null,
        subagentId: el.dataset.subagentId || null,
        subagentIndex: el.dataset.subagentIndex || null,
        subagentPath: el.dataset.subagentPath || null,
        activityPath: el.dataset.activityPath || null,
      })),
      selectedAgentId:
        document.querySelector(
          '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option.active',
        )?.dataset.agentId || null,
      workspace: {
        openPanelCount: Number(
          document.getElementById("agentWorkspace")?.dataset.openPanelCount ||
            0,
        ),
        mainStreamMinWidth: Number.parseFloat(
          window
            .getComputedStyle(document.querySelector(".main-wrapper"))
            .getPropertyValue("--main-stream-min-width") || "0",
        ),
        mainStreamMaxWidth: Number.parseFloat(
          window
            .getComputedStyle(document.querySelector(".main-wrapper"))
            .getPropertyValue("--main-stream-max-width") || "0",
        ),
        mainStreamComputedMaxWidth: (() => {
          const main = document.querySelector(".agent-main-stream");
          return main
            ? Number.parseFloat(window.getComputedStyle(main).maxWidth || "0")
            : 0;
        })(),
        subagentPanelRackWidth: Number.parseFloat(
          window
            .getComputedStyle(document.querySelector(".main-wrapper"))
            .getPropertyValue("--subagent-panel-rack-width") || "0",
        ),
        overlayOpenPanelCount: Number(
          document.getElementById("subagentPanelOverlay")?.dataset
            .openPanelCount || 0,
        ),
        subagentPanelLayoutReady:
          document.querySelector(".main-wrapper")?.dataset
            .subagentPanelLayoutReady || null,
        subagentPanelOverflow:
          document.querySelector(".main-wrapper")?.dataset
            .subagentPanelOverflow || null,
        subagentPanelResizable:
          document.querySelector(".main-wrapper")?.dataset
            .subagentPanelResizable || null,
        mainStreamCount: document.querySelectorAll(".agent-main-stream").length,
        panelRackCount: document.querySelectorAll(".subagent-panel-rack")
          .length,
        subagentPanelCount: document.querySelectorAll(".subagent-panel").length,
        panelsInsideWorkspace: document.querySelectorAll(
          "#agentWorkspace .subagent-panel",
        ).length,
        mainTrackIds: Array.from(
          document.querySelectorAll(".agent-main-stream"),
        ).map((track) => track.dataset.agentId || null),
        panelTrackIds: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((track) => track.dataset.agentId || null),
        mainContentClientWidth:
          document.getElementById("mainContent")?.clientWidth ?? null,
        wrapperRect: rectOf(document.querySelector(".main-wrapper")),
        mainContentRect: rectOf(document.getElementById("mainContent")),
        mainRect: (() => {
          const main = document.querySelector(".agent-main-stream");
          return rectOf(main);
        })(),
        overlayRect: (() => {
          const overlay = document.getElementById("subagentPanelOverlay");
          return rectOf(overlay);
        })(),
        panelRects: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((panel) => rectOf(panel)),
        rackScrollLeft:
          document.getElementById("subagentPanelRack")?.scrollLeft ?? null,
        rackFlexDirection: (() => {
          const rack = document.getElementById("subagentPanelRack");
          return rack ? window.getComputedStyle(rack).flexDirection : null;
        })(),
        rackClientWidth:
          document.getElementById("subagentPanelRack")?.clientWidth ?? null,
        rackScrollWidth:
          document.getElementById("subagentPanelRack")?.scrollWidth ?? null,
        rackPaddingLeft: (() => {
          const rack = document.getElementById("subagentPanelRack");
          return rack
            ? Number.parseFloat(
                window.getComputedStyle(rack).paddingLeft || "0",
              )
            : null;
        })(),
        mainScrollTop: document.getElementById("mainContent")?.scrollTop ?? 0,
        mainScrollLeft: document.getElementById("mainContent")?.scrollLeft ?? 0,
        panelScrollTops: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((panel) => panel.scrollTop),
        panelScrollLefts: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((panel) => panel.scrollLeft),
        panelWidths: Array.from(
          document.querySelectorAll(".subagent-panel"),
        ).map((panel) => panel.getBoundingClientRect().width),
        scrollRanges: [
          {
            agentId: "main",
            range: scrollRangeOf(document.getElementById("mainContent")),
          },
          ...Array.from(document.querySelectorAll(".subagent-panel")).map(
            (panel) => ({
              agentId: panel.dataset.agentId || null,
              range: scrollRangeOf(panel),
            }),
          ),
        ],
        streamHeightSpacers: Array.from(
          document.querySelectorAll(".agent-stream-height-spacer"),
        ).map((spacer) => ({
          agentId: spacer.dataset.agentId || null,
          height: spacer.getBoundingClientRect().height,
          spacerPx: Number(spacer.dataset.streamHeightSpacerPx || 0),
          unifiedRange: Number(spacer.dataset.unifiedScrollRangePx || 0),
        })),
        connectorPlacements: Array.from(
          document.querySelectorAll(".agent-connector"),
        ).map((connector) => {
          const track = connector.closest(".agent-track");
          const header = connector.closest(".agent-track-header");
          const body = track?.querySelector(":scope > .agent-track-body");
          const firstMessage = document.getElementById(
            connector.dataset.firstMessageId || "",
          );
          const connectorRect = rectOf(connector);
          const bodyRect = rectOf(body);
          const firstRect = rectOf(firstMessage);
          return {
            subagentId: connector.dataset.subagentId || null,
            insideHeader: Boolean(header),
            insideBody: Boolean(connector.closest(".agent-track-body")),
            connectorLeft: connectorRect?.left ?? null,
            connectorRight: connectorRect?.right ?? null,
            bodyLeft: bodyRect?.left ?? null,
            bodyRight: bodyRect?.right ?? null,
            connectorBottom: connectorRect?.bottom ?? null,
            bodyTop: bodyRect?.top ?? null,
            firstMessageTop: firstRect?.top ?? null,
            overlapsFirstMessage:
              connectorRect && firstRect
                ? connectorRect.bottom > firstRect.top
                : null,
          };
        }),
        panelTitleMetrics: Array.from(
          document.querySelectorAll(".subagent-panel .agent-track-title"),
        ).map((title) => {
          const track = title.closest(".agent-track");
          const styles = window.getComputedStyle(title);
          return {
            agentId: track?.dataset.agentId || null,
            text: title.textContent.replace(/\s+/g, " ").trim(),
            clientWidth: title.clientWidth,
            scrollWidth: title.scrollWidth,
            whiteSpace: styles.whiteSpace,
            overflowX: styles.overflowX,
            textOverflow: styles.textOverflow,
          };
        }),
        separator: (() => {
          const separator = document.querySelector(".agent-stream-separator");
          if (!separator) return { exists: false };
          const styles = window.getComputedStyle(separator);
          const dividerLineStyles = window.getComputedStyle(
            separator,
            "::before",
          );
          const grabberStyles = window.getComputedStyle(separator, "::after");
          const rect = separator.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            exists: true,
            rect: rectOf(separator),
            hitTargetTag: hitTarget?.tagName || null,
            hitTargetId: hitTarget?.id || null,
            hitTargetClass: hitTarget?.className || null,
            role: separator.getAttribute("role"),
            ariaOrientation: separator.getAttribute("aria-orientation"),
            ariaLabel: separator.getAttribute("aria-label"),
            ariaValueMin: separator.getAttribute("aria-valuemin"),
            ariaValueMax: separator.getAttribute("aria-valuemax"),
            ariaValueNow: separator.getAttribute("aria-valuenow"),
            tabIndex: separator.tabIndex,
            display: styles.display,
            position: styles.position,
            zIndex: Number(styles.zIndex),
            pointerEvents: styles.pointerEvents,
            cursor: styles.cursor,
            backgroundImage: styles.backgroundImage,
            backgroundSize: styles.backgroundSize,
            boxShadow: styles.boxShadow,
            dividerLinePosition: dividerLineStyles.position,
            dividerLineTop: dividerLineStyles.top,
            dividerLineBottom: dividerLineStyles.bottom,
            dividerLineWidth: dividerLineStyles.width,
            dividerLineHeight: dividerLineStyles.height,
            dividerLineBorderTopWidth: dividerLineStyles.borderTopWidth,
            dividerLineBorderRightWidth: dividerLineStyles.borderRightWidth,
            dividerLineBorderBottomWidth: dividerLineStyles.borderBottomWidth,
            dividerLineBorderLeftWidth: dividerLineStyles.borderLeftWidth,
            dividerLineBorderRadius: dividerLineStyles.borderRadius,
            dividerLineBackgroundColor: dividerLineStyles.backgroundColor,
            dividerLineBoxShadow: dividerLineStyles.boxShadow,
            dividerLineClipPath: dividerLineStyles.clipPath,
            grabberPosition: grabberStyles.position,
            grabberTop: grabberStyles.top,
            grabberWidth: grabberStyles.width,
            grabberHeight: grabberStyles.height,
            grabberBorderTopWidth: grabberStyles.borderTopWidth,
            grabberBorderRightWidth: grabberStyles.borderRightWidth,
            grabberBorderBottomWidth: grabberStyles.borderBottomWidth,
            grabberBorderLeftWidth: grabberStyles.borderLeftWidth,
            grabberBorderRadius: grabberStyles.borderRadius,
            grabberBackgroundColor: grabberStyles.backgroundColor,
            grabberBoxShadow: grabberStyles.boxShadow,
          };
        })(),
      },
      selectedAgentChips: Array.from(
        document.querySelectorAll(".selected-agent-chip"),
      ).map((chip) => ({
        agentId: chip.dataset.agentId || null,
        active: chip.classList.contains("active"),
        text: chip.textContent.replace(/\s+/g, " ").trim(),
      })),
      agentFilters: Array.from(document.querySelectorAll(".agent-filter")).map(
        (filter) => ({
          location: filter.dataset.agentFilterLocation || null,
          scrollLeft: filter.scrollLeft,
          maxScrollLeft: Math.max(0, filter.scrollWidth - filter.clientWidth),
          options: Array.from(
            filter.querySelectorAll(".agent-filter-option"),
          ).map((option) => ({
            agentId: option.dataset.agentId || null,
            kind: option.dataset.trackKind || null,
            active: option.classList.contains("active"),
            panelOpen: option.dataset.panelOpen === "true",
            ariaPressed: option.getAttribute("aria-pressed"),
            text: option.textContent.replace(/\s+/g, " ").trim(),
          })),
        }),
      ),
      tracks: Array.from(document.querySelectorAll(".agent-track")).map(
        (el) => ({
          agentId: el.dataset.agentId || null,
          kind: el.dataset.trackKind || null,
          panelOpen: el.dataset.panelOpen === "true",
          active: el.classList.contains("active"),
          model:
            el.querySelector(".agent-track-model")?.dataset.trackModel || null,
          messageIds: Array.from(
            el.querySelectorAll(".agent-track-message"),
          ).map((message) => message.id),
        }),
      ),
      connectors: Array.from(document.querySelectorAll(".agent-connector")).map(
        (el) => {
          const sourceMessageId = el.dataset.sourceMessageId || "";
          const spawnPromptId = el.dataset.spawnPromptId || "";
          const firstMessageId = el.dataset.firstMessageId || "";
          const sourceMessage = document.getElementById(sourceMessageId);
          const firstMessage = document.getElementById(firstMessageId);
          const spacer = el
            .closest(".agent-track")
            ?.querySelector(".agent-alignment-spacer");
          const sourceTop = sourceMessage?.getBoundingClientRect().top ?? null;
          const firstTop = firstMessage?.getBoundingClientRect().top ?? null;
          return {
            subagentId: el.dataset.subagentId || null,
            sourceAgentId: el.dataset.sourceAgentId || null,
            sourceMessageId,
            spawnPromptId,
            firstMessageId,
            sourceMessageExists: Boolean(sourceMessage),
            spawnPromptExists: Boolean(document.getElementById(spawnPromptId)),
            firstMessageExists: Boolean(firstMessage),
            sourceTop,
            firstTop,
            firstMessageTopDelta:
              sourceTop !== null && firstTop !== null
                ? firstTop - sourceTop
                : null,
            connectorHeight: el.getBoundingClientRect().height,
            alignmentOffset: Number(spacer?.dataset.alignmentOffsetPx || 0),
            alignmentStatus: spacer?.dataset.alignmentStatus || null,
            alignmentConnectorHeight: Number(
              spacer?.dataset.connectorHeightPx || 0,
            ),
          };
        },
      ),
      activityStreamCount: document.querySelectorAll("#activityStream").length,
      mainContentAgentFilters: document.querySelectorAll(
        '.timeline > .agent-filter, .agent-filter[data-agent-filter-location="main"]',
      ).length,
      timelineSpacers: Array.from(
        document.querySelectorAll(".timeline-spacer"),
      ).map((el) => ({
        minutes: Number(el.dataset.offsetMinutes || 0),
        text: el.textContent.replace(/\s+/g, " ").trim(),
        height: Number.parseFloat(el.style.height || "0"),
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
      })),
      timelineIdleBreaks: Array.from(
        document.querySelectorAll(".timeline-idle-break"),
      ).map((el) => ({
        minutes: Number(el.dataset.idleMinutes || 0),
        text: el.textContent.replace(/\s+/g, " ").trim(),
        height: Number.parseFloat(el.style.height || "0"),
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
      })),
      alignmentSpacers: Array.from(
        document.querySelectorAll(".agent-alignment-spacer"),
      ).map((el) => ({
        trackKind: el.closest(".agent-track")?.dataset.trackKind || null,
        trackId: el.closest(".agent-track")?.dataset.agentId || null,
        height: Number.parseFloat(el.style.height || "0"),
        status: el.dataset.alignmentStatus || null,
        connectorHeight: Number(el.dataset.connectorHeightPx || 0),
        parentMessageId: el.dataset.parentMessageId || null,
        firstMessageId: el.dataset.firstMessageId || null,
      })),
      toolBodyIds: Array.from(document.querySelectorAll(".tool-body")).map(
        (el) => el.id,
      ),
      nestedActivityCards: document.querySelectorAll(".message .activity-card")
        .length,
      nestedSubagentCards: document.querySelectorAll(
        ".message .subagent-transcript",
      ).length,
      subagentActivityCards: document.querySelectorAll(
        ".activity-card.subagent-transcript",
      ).length,
      activityCards: Array.from(
        document.querySelectorAll(".activity-card"),
      ).map((el) => ({
        id: el.id,
        kind: el.dataset.activityKind || null,
        path: el.dataset.activityPath || el.dataset.subagentPath || null,
        parentMessageIndex: el.dataset.parentMessageIndex || null,
        sourcePartIndex: el.dataset.sourcePartIndex || null,
        sourcePartId: el.dataset.sourcePartId || null,
        parentActivityPath: el.dataset.parentActivityPath || null,
        linkedSubagentPath: el.dataset.linkedSubagentPath || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      toolActivities: Array.from(
        document.querySelectorAll(".tool-activity"),
      ).map((el) => ({
        id: el.id,
        path: el.dataset.activityPath || null,
        linkedSubagentPath: el.dataset.linkedSubagentPath || null,
        visible:
          window.getComputedStyle(el).display !== "none" &&
          el.getAttribute("aria-hidden") !== "true",
        insideMessageGroup: Boolean(el.closest(".agent-message-group")),
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      toolRefs: Array.from(document.querySelectorAll(".part-activity-ref")).map(
        (el) => ({
          path: el.dataset.activityPath || null,
          linkedSubagentPath: el.dataset.linkedSubagentPath || null,
          hasButton: Boolean(el.querySelector("[data-tool-result-button]")),
          text: el.textContent.replace(/\s+/g, " ").trim(),
        }),
      ),
      reasoningBlocks: Array.from(
        document.querySelectorAll(".part-reasoning"),
      ).map((el) => ({
        tagName: el.tagName,
        open: el.hasAttribute("open"),
        collapsed: el.dataset.reasoningCollapsed || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      claudeCodeBlocks: Array.from(
        document.querySelectorAll(".claude-code-block"),
      ).map((el) => ({
        kind: el.dataset.claudeCodeBlock || null,
        text: el.textContent.replace(/\s+/g, " ").trim(),
      })),
      customClaudeElements: Array.from(
        document.querySelectorAll(
          ".part-text task, .part-text task_result, .part-text path, .part-text content, .part-text shell_metadata",
        ),
      ).map((el) => el.tagName.toLowerCase()),
    };
  }, selector);
}

function baseMessage(
  parts,
  finish = "tool-calls",
  time = "2026-06-18T00:00:00Z",
) {
  return {
    role: "assistant",
    time_created: time,
    finish,
    parts,
  };
}

function taskPart(id, sessionId, prompt) {
  return {
    type: "tool",
    tool: "task",
    id,
    state: {
      input: { subagent_type: "general", prompt },
      metadata: { sessionId },
      output: `${prompt} done`,
    },
  };
}

async function verifyAgentStreamPresentation(browser) {
  const page = await setupPage(browser);
  const claudeText = [
    "Before block.",
    '<task id="abc" state="completed">',
    "<task_result>",
    "Claude task output",
    "</task_result>",
    "</task>",
    "After block.",
  ].join("\n");
  const tallText = Array.from(
    { length: 18 },
    (_, index) =>
      `Scrollable paragraph ${index + 1}. This content intentionally makes the stream tall enough for vertical scroll synchronization checks.`,
  ).join("\n\n");
  const firstTranscript = {
    task_part_id: "first-task",
    agent_type: "general",
    summary: {
      id: "first-session",
      title: "First model panel",
      model: "claude-sonnet-4",
    },
    messages: [
      {
        role: "assistant",
        modelID: "claude-sonnet-4",
        time_created: "2026-06-18T00:01:00Z",
        finish: "stop",
        parts: [
          { type: "reasoning", text: "Internal chain of action." },
          { type: "text", text: `${claudeText}\n\n${tallText}` },
        ],
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "assistant",
        modelID: "claude-sonnet-4",
        time_created: `2026-06-18T00:${String(index + 10).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [
          {
            type: "text",
            text: `${tallText}\n\nFirst panel filler ${index + 1}`,
          },
        ],
      })),
    ],
    subagent_transcripts: [],
  };
  const secondTranscript = {
    task_part_id: "second-task",
    agent_type: "general",
    summary: {
      id: "second-session",
      title: "Second model panel",
      model: "deepseek-v4-pro",
    },
    messages: [
      {
        role: "assistant",
        modelID: "deepseek-v4-pro",
        time_created: "2026-06-18T00:02:00Z",
        finish: "stop",
        parts: [{ type: "text", text: `second answer\n\n${tallText}` }],
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: "assistant",
        modelID: "deepseek-v4-pro",
        time_created: `2026-06-18T00:${String(index + 20).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [
          {
            type: "text",
            text: `${tallText}\n\nSecond panel filler ${index + 1}`,
          },
        ],
      })),
    ],
    subagent_transcripts: [],
  };
  const extraTranscripts = Array.from({ length: 6 }, (_, index) => ({
    task_part_id: `extra-task-${index}`,
    agent_type: "general",
    summary: {
      id: `extra-session-${index}`,
      title: `Extra long titled panel ${index + 1} that must not overlap neighboring panel close controls`,
      model: "k2p7",
    },
    messages: [
      {
        role: "assistant",
        modelID: "k2p7",
        time_created: `2026-06-18T00:${String(index + 3).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [
          { type: "text", text: `extra answer ${index + 1}\n\n${tallText}` },
        ],
      },
      ...Array.from({ length: 6 }, (_, fillerIndex) => ({
        role: "assistant",
        modelID: "k2p7",
        time_created: `2026-06-18T01:${String(fillerIndex + index * 6).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [
          {
            type: "text",
            text: `${tallText}\n\nExtra panel ${index + 1} filler ${fillerIndex + 1}`,
          },
        ],
      })),
    ],
    subagent_transcripts: [],
  }));

  await runSyntheticSession(page, {
    id: "agent-stream-presentation",
    messages: [
      {
        role: "assistant",
        modelID: "main-model-a",
        time_created: "2026-06-18T00:00:00Z",
        finish: "tool-calls",
        parts: [
          { type: "reasoning", text: "Main stream thinking." },
          taskPart("first-task", "first-session", "first"),
          taskPart("second-task", "second-session", "second"),
          ...extraTranscripts.map((transcript, index) =>
            taskPart(
              `extra-task-${index}`,
              transcript.summary.id,
              `extra ${index + 1}`,
            ),
          ),
        ],
      },
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant",
        modelID: "main-model-a",
        time_created: `2026-06-18T02:${String(index).padStart(2, "0")}:00Z`,
        finish: "stop",
        parts: [
          {
            type: "text",
            text: `${tallText}\n\nMain stream filler ${index + 1}`,
          },
        ],
      })),
    ],
    subagent_transcripts: [
      firstTranscript,
      secondTranscript,
      ...extraTranscripts,
    ],
  });

  const initialState = await readIdentityState(page, ".message-item");
  const rectCenter = (rect) => (rect.left + rect.right) / 2;
  const nearlyEqual = (left, right, tolerance = 1) =>
    Math.abs(left - right) <= tolerance;
  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const smallerGoldenSegment = (width) => width / (goldenRatio + 1);
  const largerGoldenSegment = (width) => width / goldenRatio;
  const rectInside = (inner, outer, tolerance = 1) =>
    inner.left >= outer.left - tolerance &&
    inner.right <= outer.right + tolerance;
  const panelsFlowRightToLeft = (state) =>
    state.workspace.rackFlexDirection === "row-reverse" &&
    state.workspace.panelRects.every((rect, index, rects) => {
      if (index === 0) return true;
      return rect.right < rects[index - 1].left;
    });
  const separatorShowsSplit = (state) => {
    const separator = state.workspace.separator;
    const rect = separator.rect;
    const mainRect = state.workspace.mainContentRect;
    const overlayRect = state.workspace.overlayRect;
    const splitBoundary = overlayRect.left;
    const lineWidth = Number.parseFloat(separator.dividerLineWidth || "0");
    const grabberTop = Number.parseFloat(separator.grabberTop || "0");
    const grabberWidth = Number.parseFloat(separator.grabberWidth || "0");
    const grabberHeight = Number.parseFloat(separator.grabberHeight || "0");
    const lineColorChannels =
      separator.dividerLineBackgroundColor
        ?.match(/rgba?\(([^)]+)\)/)?.[1]
        ?.split(",")
        .map((channel) => Number.parseFloat(channel.trim())) || [];
    const lineColorSpread =
      lineColorChannels.length >= 3
        ? Math.max(...lineColorChannels.slice(0, 3)) -
          Math.min(...lineColorChannels.slice(0, 3))
        : Number.POSITIVE_INFINITY;
    const lineOpacity =
      lineColorChannels.length >= 4 ? lineColorChannels[3] : 1;
    const lineRightShadowPattern = /\b[56]px 0px 1[24]px/;
    const grabberRightShadowPattern = /\b[78]px 0px 1[46]px/;

    return (
      separator.exists &&
      separator.role === "separator" &&
      state.workspace.subagentPanelLayoutReady === "true" &&
      state.workspace.subagentPanelOverflow === "true" &&
      state.workspace.subagentPanelResizable === "true" &&
      separator.ariaOrientation === "vertical" &&
      separator.ariaLabel &&
      separator.tabIndex === 0 &&
      separator.display !== "none" &&
      separator.position === "absolute" &&
      separator.zIndex >= 30 &&
      separator.hitTargetId === "agentStreamSeparator" &&
      separator.pointerEvents === "auto" &&
      separator.cursor === "col-resize" &&
      Number(separator.ariaValueMin) > 0 &&
      Number(separator.ariaValueMax) >= Number(separator.ariaValueMin) &&
      Math.abs(Number(separator.ariaValueNow) - overlayRect.width) <= 1 &&
      rect.height >= overlayRect.height - 1 &&
      Math.abs(rect.top - overlayRect.top) <= 1 &&
      Math.abs(rect.bottom - overlayRect.bottom) <= 1 &&
      Math.abs(mainRect.right - splitBoundary) <= 1 &&
      rect.left < splitBoundary &&
      rect.right > splitBoundary &&
      nearlyEqual(rectCenter(rect), splitBoundary, 1) &&
      separator.backgroundImage === "none" &&
      separator.boxShadow === "none" &&
      separator.dividerLinePosition === "absolute" &&
      separator.dividerLineTop === "0px" &&
      separator.dividerLineBottom === "0px" &&
      lineWidth >= 2 &&
      lineWidth <= 3 &&
      separator.dividerLineBorderTopWidth === "0px" &&
      separator.dividerLineBorderRightWidth === "0px" &&
      separator.dividerLineBorderBottomWidth === "0px" &&
      separator.dividerLineBorderLeftWidth === "0px" &&
      separator.dividerLineBorderRadius === "0px" &&
      lineColorSpread <= 8 &&
      lineOpacity > 0.4 &&
      lineRightShadowPattern.test(separator.dividerLineBoxShadow) &&
      separator.dividerLineClipPath !== "none" &&
      separator.grabberPosition === "absolute" &&
      nearlyEqual(grabberTop, rect.height / 2, 1) &&
      grabberWidth === 8 &&
      grabberHeight === 44 &&
      separator.grabberBorderTopWidth === "1px" &&
      separator.grabberBorderRightWidth === "1px" &&
      separator.grabberBorderBottomWidth === "1px" &&
      separator.grabberBorderLeftWidth === "1px" &&
      separator.grabberBorderRadius !== "0px" &&
      separator.grabberBackgroundColor !== "rgba(0, 0, 0, 0)" &&
      grabberRightShadowPattern.test(separator.grabberBoxShadow)
    );
  };
  const separatorResizeSnapshot = (state) => ({
    overlayWidth: state.workspace.overlayRect?.width ?? null,
    mainContentWidth: state.workspace.mainContentRect?.width ?? null,
    rackClientWidth: state.workspace.rackClientWidth,
    rackScrollWidth: state.workspace.rackScrollWidth,
    separator: state.workspace.separator,
  });
  const separatorIsHidden = (state) =>
    state.workspace.separator.display === "none" &&
    state.workspace.separator.ariaValueNow === null;
  const mainStreamMaxUsesGoldenRatio = (state) =>
    nearlyEqual(
      state.workspace.mainStreamMaxWidth,
      largerGoldenSegment(
        state.workspace.wrapperRect.width -
          state.workspace.subagentPanelRackWidth,
      ),
      1,
    ) &&
    nearlyEqual(
      state.workspace.mainStreamComputedMaxWidth,
      state.workspace.mainStreamMaxWidth,
      1,
    );
  const dragSeparatorBy = async (deltaX) => {
    const separator = page.locator(".agent-stream-separator");
    const box = await separator.boundingBox();
    assert(Boolean(box), "separator handle was not available for dragging");

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX, y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };
  assert(
    initialState.workspace.mainStreamCount === 1 &&
      initialState.workspace.subagentPanelCount === 0 &&
      initialState.workspace.separator.display === "none" &&
      mainStreamMaxUsesGoldenRatio(initialState) &&
      initialState.workspace.mainRect.width <=
        initialState.workspace.mainStreamMaxWidth + 1 &&
      nearlyEqual(
        rectCenter(initialState.workspace.mainRect),
        rectCenter(initialState.workspace.mainContentRect),
        1,
      ),
    "initial main agent stream should be centered when no subagent panels are open",
    initialState,
  );

  const firstOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(0);
  const secondOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(1);
  const firstAgentId = await firstOption.getAttribute("data-agent-id");
  const secondAgentId = await secondOption.getAttribute("data-agent-id");
  await firstOption.click();
  await page.waitForTimeout(100);
  const firstOpenState = await readIdentityState(page, ".message-item");
  assert(
    firstOpenState.workspace.subagentPanelCount === 1 &&
      firstOpenState.workspace.panelTrackIds[0] === firstAgentId &&
      firstOpenState.workspace.rackFlexDirection === "row-reverse" &&
      firstOpenState.workspace.subagentPanelLayoutReady === "true" &&
      firstOpenState.workspace.subagentPanelOverflow === "false" &&
      firstOpenState.workspace.subagentPanelResizable === "false" &&
      nearlyEqual(
        firstOpenState.workspace.mainStreamMinWidth,
        smallerGoldenSegment(firstOpenState.workspace.wrapperRect.width),
        1,
      ) &&
      mainStreamMaxUsesGoldenRatio(firstOpenState) &&
      firstOpenState.workspace.mainContentRect.width <
        initialState.workspace.mainContentRect.width &&
      separatorIsHidden(firstOpenState) &&
      nearlyEqual(
        firstOpenState.workspace.panelRects[0].right,
        firstOpenState.workspace.overlayRect.right,
        1,
      ),
    "first opened subagent should consume right-side layout space without showing the split separator",
    { initialState, firstOpenState },
  );

  await secondOption.click();
  await page.waitForTimeout(100);

  const openedState = await readIdentityState(page, ".message-item");
  assert(
    openedState.workspace.mainStreamCount === 1 &&
      openedState.workspace.subagentPanelCount === 2 &&
      openedState.workspace.openPanelCount === 2 &&
      openedState.workspace.overlayOpenPanelCount === 2 &&
      openedState.workspace.panelsInsideWorkspace === 0 &&
      openedState.workspace.subagentPanelOverflow === "true" &&
      openedState.workspace.subagentPanelResizable === "true" &&
      nearlyEqual(
        openedState.workspace.mainStreamMinWidth,
        smallerGoldenSegment(openedState.workspace.wrapperRect.width),
        1,
      ) &&
      mainStreamMaxUsesGoldenRatio(openedState) &&
      separatorShowsSplit(openedState) &&
      panelsFlowRightToLeft(openedState) &&
      openedState.workspace.mainTrackIds[0] === "main" &&
      openedState.workspace.panelTrackIds.includes(firstAgentId) &&
      openedState.workspace.panelTrackIds.includes(secondAgentId),
    "clicking multiple subagents should keep main stream and separated open right-side panels",
    openedState,
  );
  assert(
    openedState.workspace.mainContentRect.width <
      firstOpenState.workspace.mainContentRect.width &&
      openedState.workspace.panelTrackIds[0] === firstAgentId &&
      openedState.workspace.panelTrackIds[1] === secondAgentId &&
      openedState.workspace.rackPaddingLeft >= 16 &&
      openedState.workspace.panelRects[0].left >
        openedState.workspace.panelRects[1].right &&
      openedState.workspace.panelRects[1].left -
        openedState.workspace.separator.rect.right >=
        6 &&
      rectInside(
        openedState.workspace.panelRects[1],
        openedState.workspace.overlayRect,
        3,
      ),
    "opening a second subagent should lay it to the left while preserving right-to-left panel order",
    { firstOpenState, openedState },
  );
  assert(
    openedState.workspace.panelWidths.every((width) => width <= 522),
    "subagent panels should respect the configured maximum width",
    openedState,
  );
  assert(
    openedState.workspace.connectorPlacements.length === 2 &&
      openedState.workspace.connectorPlacements.every(
        (connector) =>
          connector.insideHeader &&
          !connector.insideBody &&
          connector.connectorBottom <= connector.bodyTop + 1 &&
          nearlyEqual(connector.connectorLeft, connector.bodyLeft, 1) &&
          nearlyEqual(connector.connectorRight, connector.bodyRight, 1),
      ),
    "subagent relationship controls should be pinned in the header and span the stream body edges",
    openedState,
  );
  assert(
    openedState.workspace.panelTitleMetrics.length === 2 &&
      openedState.workspace.panelTitleMetrics.every(
        (title) =>
          title.whiteSpace !== "nowrap" &&
          title.textOverflow !== "ellipsis" &&
          title.scrollWidth <= title.clientWidth + 1,
      ),
    "subagent panel titles should wrap instead of being visually truncated",
    openedState,
  );
  assert(
    openedState.tracks.some(
      (track) =>
        track.agentId === firstAgentId && track.model === "claude-sonnet-4",
    ) &&
      openedState.tracks.some(
        (track) =>
          track.agentId === secondAgentId && track.model === "deepseek-v4-pro",
      ),
    "subagent panels should display their fixed model in the stream header",
    openedState,
  );
  assert(
    openedState.reasoningBlocks.length === 2 &&
      openedState.reasoningBlocks.every(
        (block) =>
          block.tagName === "DETAILS" &&
          !block.open &&
          block.collapsed === "true",
      ),
    "reasoning blocks should render as collapsed details by default",
    openedState,
  );
  assert(
    openedState.claudeCodeBlocks.length === 1 &&
      openedState.claudeCodeBlocks[0].kind === "task" &&
      openedState.claudeCodeBlocks[0].text.includes("<task") &&
      openedState.claudeCodeBlocks[0].text.includes("<task_result>") &&
      openedState.customClaudeElements.length === 0,
    "assistant Claude Code block should render as escaped code, not custom HTML elements",
    openedState,
  );

  await page.locator(".part-reasoning summary").first().click();
  await page.waitForTimeout(50);
  const expandedReasoning = await readIdentityState(page, ".message-item");
  assert(
    expandedReasoning.reasoningBlocks.some((block) => block.open),
    "reasoning details should expand when clicked",
    expandedReasoning,
  );

  for (let index = 2; index < 8; index += 1) {
    await page
      .locator(
        '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
      )
      .nth(index)
      .click();
    await page.waitForTimeout(50);
  }
  const manyPanelsState = await readIdentityState(page, ".message-item");
  assert(
    manyPanelsState.workspace.subagentPanelCount === 8 &&
      manyPanelsState.workspace.openPanelCount === 8 &&
      manyPanelsState.workspace.overlayOpenPanelCount === 8 &&
      manyPanelsState.workspace.panelsInsideWorkspace === 0 &&
      mainStreamMaxUsesGoldenRatio(manyPanelsState) &&
      separatorShowsSplit(manyPanelsState) &&
      panelsFlowRightToLeft(manyPanelsState) &&
      manyPanelsState.workspace.rackScrollWidth >
        manyPanelsState.workspace.rackClientWidth,
    "opening many long-titled subagent panels should keep every panel mounted behind the split separator",
    manyPanelsState,
  );
  assert(
    manyPanelsState.workspace.mainContentRect.width <=
      openedState.workspace.mainContentRect.width + 1 &&
      manyPanelsState.workspace.mainRect.width <
        initialState.workspace.mainRect.width,
    "opening many right-side panels should shrink the main content area and reflow the main stream",
    { initialState, openedState, manyPanelsState },
  );
  assert(
    manyPanelsState.workspace.panelWidths.every((width) => width <= 522),
    "every opened floating subagent panel should respect the maximum width",
    manyPanelsState,
  );
  assert(
    manyPanelsState.workspace.panelTitleMetrics.length === 8 &&
      manyPanelsState.workspace.panelTitleMetrics.every(
        (title) =>
          title.whiteSpace !== "nowrap" &&
          title.textOverflow !== "ellipsis" &&
          title.scrollWidth <= title.clientWidth + 1,
      ),
    "long subagent panel titles should wrap without horizontal title overflow",
    manyPanelsState,
  );

  await dragSeparatorBy(96);
  const afterSeparatorDragRight = await readIdentityState(
    page,
    ".message-item",
  );
  assert(
    separatorShowsSplit(afterSeparatorDragRight) &&
      afterSeparatorDragRight.workspace.overlayRect.width <
        manyPanelsState.workspace.overlayRect.width - 40 &&
      afterSeparatorDragRight.workspace.mainContentRect.width >
        manyPanelsState.workspace.mainContentRect.width + 40 &&
      afterSeparatorDragRight.workspace.rackScrollWidth >
        afterSeparatorDragRight.workspace.rackClientWidth,
    "dragging the separator right should expand main content and shrink subagent panel space",
    {
      before: separatorResizeSnapshot(manyPanelsState),
      after: separatorResizeSnapshot(afterSeparatorDragRight),
    },
  );

  await page.locator(".agent-stream-separator").press("ArrowLeft");
  await page.waitForTimeout(100);
  const afterSeparatorKeyboardLeft = await readIdentityState(
    page,
    ".message-item",
  );
  assert(
    separatorShowsSplit(afterSeparatorKeyboardLeft) &&
      afterSeparatorKeyboardLeft.workspace.overlayRect.width >
        afterSeparatorDragRight.workspace.overlayRect.width + 10 &&
      afterSeparatorKeyboardLeft.workspace.mainContentRect.width <
        afterSeparatorDragRight.workspace.mainContentRect.width - 10,
    "keyboard resizing the separator left should give subagent panels more space",
    { afterSeparatorDragRight, afterSeparatorKeyboardLeft },
  );

  await page.evaluate(() => {
    const rack = document.getElementById("subagentPanelRack");
    if (rack) {
      const maxDistance = Math.max(0, rack.scrollWidth - rack.clientWidth);
      const direction = window.getComputedStyle(rack).flexDirection;
      rack.scrollLeft =
        direction === "row-reverse"
          ? -Math.min(120, maxDistance)
          : Math.min(120, maxDistance);
    }
    const main = document.getElementById("mainContent");
    if (main) {
      main.scrollTop = Math.min(240, main.scrollHeight - main.clientHeight);
    }
  });
  await page.waitForTimeout(100);
  const syncedScrollState = await readIdentityState(page, ".message-item");
  const scrollRanges = syncedScrollState.workspace.scrollRanges.map(
    (entry) => entry.range,
  );
  const maxScrollRange = Math.max(...scrollRanges);
  assert(
    scrollRanges.length === 9 &&
      scrollRanges.every((range) => Math.abs(range - maxScrollRange) <= 1) &&
      syncedScrollState.workspace.streamHeightSpacers.length === 9 &&
      syncedScrollState.workspace.streamHeightSpacers.every(
        (spacer) => Math.abs(spacer.unifiedRange - maxScrollRange) <= 1,
      ),
    "active agent streams should share the tallest stream's scrollable height",
    syncedScrollState,
  );
  assert(
    syncedScrollState.workspace.panelScrollTops.length === 8 &&
      syncedScrollState.workspace.panelScrollTops.every(
        (top) => Math.abs(top - syncedScrollState.workspace.mainScrollTop) <= 1,
      ),
    "main vertical scrolling should synchronize subagent panel scrollTop values",
    syncedScrollState,
  );
  assert(
    Math.abs(syncedScrollState.workspace.rackScrollLeft) > 0 &&
      syncedScrollState.workspace.mainScrollLeft === 0 &&
      syncedScrollState.workspace.panelScrollLefts.every((left) => left === 0),
    "vertical scroll synchronization should not synchronize horizontal scroll positions",
    syncedScrollState,
  );

  await page
    .locator(
      `.subagent-panel[data-agent-id="${firstAgentId}"] .agent-panel-close`,
    )
    .click();
  await page.waitForTimeout(100);
  const afterClose = await readIdentityState(page, ".message-item");
  assert(
    afterClose.workspace.subagentPanelCount === 7 &&
      !afterClose.workspace.panelTrackIds.includes(firstAgentId) &&
      afterClose.workspace.panelTrackIds.includes(secondAgentId) &&
      !afterClose.agentFilters[0].options.find(
        (option) => option.agentId === firstAgentId,
      )?.panelOpen,
    "closing a subagent panel should deselect it without closing other panels",
    afterClose,
  );

  await page.close();
  return { openedState, expandedReasoning, manyPanelsState, afterClose };
}

async function verifySeparatorHiddenWhenPanelCannotLayout(browser) {
  const page = await setupPage(browser, { width: 760, height: 1000 });
  const transcript = {
    task_part_id: "narrow-task",
    agent_type: "general",
    summary: { id: "narrow-session", title: "Narrow panel transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "narrow panel answer" }],
        "stop",
        "2026-06-18T00:01:00Z",
      ),
    ],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "narrow-layout",
    messages: [
      baseMessage(
        [taskPart("narrow-task", "narrow-session", "narrow")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
    ],
    subagent_transcripts: [transcript],
  });

  await page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .first()
    .click();
  await page.waitForTimeout(100);

  const state = await readIdentityState(page, ".message-item");
  assert(
    state.workspace.subagentPanelCount === 1 &&
      state.workspace.overlayOpenPanelCount === 1 &&
      state.workspace.subagentPanelLayoutReady === "false" &&
      state.workspace.subagentPanelOverflow === "true" &&
      state.workspace.subagentPanelResizable === "false" &&
      state.workspace.overlayRect.width < 320 &&
      state.workspace.separator.display === "none" &&
      state.workspace.separator.ariaValueNow === null,
    "separator should stay hidden when the floating panel cannot fit a minimum-width panel",
    state,
  );

  await page.close();
  return state;
}

async function verifyRepeatedTopLevelTranscript(browser) {
  const page = await setupPage(browser);
  const sharedTranscript = {
    task_part_id: "unused-shared-task",
    agent_type: "general",
    summary: { id: "shared-session", title: "Shared transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "shared answer" }],
        "stop",
        "2026-06-18T00:01:00Z",
      ),
    ],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "top-level-repeat",
    messages: [
      baseMessage(
        [taskPart("main-a", "shared-session", "main A")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
      baseMessage(
        [taskPart("main-b", "shared-session", "main B")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [sharedTranscript],
  });

  const secondSubagentOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .nth(1);
  await secondSubagentOption.click();
  const selectedAgentId =
    await secondSubagentOption.getAttribute("data-agent-id");
  await page
    .locator(`.message-item[data-agent-id="${selectedAgentId}"]`)
    .click();
  await page.waitForTimeout(100);
  const state = await readIdentityState(page, ".message-item");
  const subagentTrackIds = state.tracks
    .filter((track) => track.kind === "subagent")
    .map((track) => track.agentId);
  const navSubagentIds = state.agentFilters[0].options
    .filter((option) => option.kind === "subagent")
    .map((option) => option.agentId);
  assert(
    state.duplicateIds.length === 0,
    "top-level repeat created duplicate DOM ids",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "top-level activities are nested in messages",
    state,
  );
  assert(
    state.nestedSubagentCards === 0,
    "top-level subagent cards are nested in messages",
    state,
  );
  assert(
    state.subagentActivityCards === 0,
    "top-level subagent transcripts should render as tracks, not activity cards",
    state,
  );
  assert(
    state.agentFilters.length === 1 &&
      navSubagentIds.length === 2 &&
      new Set(navSubagentIds).size === 2,
    "top-level repeat did not expose distinct subagent navigation options",
    state,
  );
  assert(
    state.tracks.length === 2 &&
      state.workspace.mainStreamCount === 1 &&
      state.workspace.subagentPanelCount === 1 &&
      subagentTrackIds.length === 1 &&
      subagentTrackIds[0] === selectedAgentId &&
      state.workspace.panelTrackIds[0] === selectedAgentId,
    "top-level repeat should render the main stream plus only the opened subagent panel",
    state,
  );
  assert(
    state.agentFilters[0].options.length === 3 &&
      state.agentFilters.every(
        (filter) =>
          filter.options.filter((option) => option.active).length === 1,
      ),
    "top-level sidebar agent filter did not expose exactly one selected track",
    state,
  );
  assert(
    state.mainContentAgentFilters === 0,
    "top-level main content should not render an agent selector",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "top-level tool results should not render in a bottom activity stream",
    state,
  );
  assert(
    state.workspace.openPanelCount === 1 &&
      state.selectedAgentChips.length === 1 &&
      state.selectedAgentChips[0].agentId === selectedAgentId &&
      state.agentFilters[0].options.some(
        (option) =>
          option.agentId === selectedAgentId &&
          option.panelOpen &&
          option.ariaPressed === "true",
      ),
    "top-level opened subagent panel state is not reflected in the sidebar",
    state,
  );
  assert(
    state.connectors.length === 1 &&
      state.connectors.every(hasAlignedConnector),
    "top-level opened panel connector does not align first message to parent message",
    state,
  );
  assert(
    state.rows.length === 1 &&
      state.rows[0].agentId === selectedAgentId &&
      state.rows[0].messageIndex === "0",
    "top-level sidebar is not scoped to the selected subagent stream",
    state,
  );
  assert(
    state.activeRows.length === 1 &&
      state.activeRows[0].agentId === selectedAgentId &&
      state.activeRows[0].messageIndex === "0",
    "top-level repeat click did not activate exactly the clicked row",
    state,
  );
  assert(
    state.toolActivities.length === 2 &&
      state.toolActivities.every(
        (activity) =>
          activity.linkedSubagentPath &&
          activity.insideMessageGroup &&
          !activity.visible,
      ),
    "task tool results were not hidden inline cards with subagent links",
    state,
  );
  assert(
    state.toolRefs.length === 2 && state.toolRefs.every((ref) => ref.hasButton),
    "task tool references are missing inline result buttons",
    state,
  );
  assert(
    state.toolActivities.some((activity) =>
      activity.text.includes("main A done"),
    ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("main B done"),
      ),
    "task tool outputs are missing from inline result cards",
    state,
  );
  assert(
    state.timelineSpacers.length === 0 && state.timelineIdleBreaks.length === 0,
    "top-level tracks should not render timestamp-based timeline spacers",
    state,
  );
  assert(
    state.alignmentSpacers.length === 1 &&
      state.alignmentSpacers.every(
        (spacer) =>
          ["aligned", "clamped"].includes(spacer.status) &&
          spacer.connectorHeight > 0,
      ),
    "top-level opened subagent panel did not record connector-aware alignment spacers",
    state,
  );
  await page.close();
  return state;
}

async function verifyRepeatedNestedTranscript(browser) {
  const page = await setupPage(browser);
  const childTranscript = {
    task_part_id: "unused-child-task",
    agent_type: "general",
    summary: { id: "child-session", title: "Repeated child transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "child answer" }],
        "stop",
        "2026-06-18T00:03:00Z",
      ),
    ],
    subagent_transcripts: [],
  };
  const parentTranscript = {
    task_part_id: "parent-task",
    agent_type: "general",
    summary: { id: "parent-session", title: "Parent transcript" },
    messages: [
      baseMessage(
        [taskPart("child-a", "child-session", "child A")],
        "tool-calls",
        "2026-06-18T00:01:00Z",
      ),
      baseMessage(
        [taskPart("child-b", "child-session", "child B")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [childTranscript],
  };

  await runSyntheticSession(page, {
    id: "nested-repeat",
    messages: [
      baseMessage(
        [taskPart("parent-task", "parent-session", "parent")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
    ],
    subagent_transcripts: [parentTranscript],
  });

  const secondChildOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-agent-id*="child-session"]',
    )
    .nth(1);
  await secondChildOption.click();
  const selectedAgentId = await secondChildOption.getAttribute("data-agent-id");
  await page
    .locator(`.message-item[data-agent-id="${selectedAgentId}"]`)
    .click();
  await page.waitForTimeout(100);
  const state = await readIdentityState(page, ".message-item");
  const childTrackIds = state.tracks
    .filter((track) => track.agentId?.includes("child-session"))
    .map((track) => track.agentId);
  const navChildIds = state.agentFilters[0].options
    .filter((option) => option.agentId?.includes("child-session"))
    .map((option) => option.agentId);
  assert(
    state.duplicateIds.length === 0,
    "nested repeat created duplicate DOM ids",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "nested activities are rendered inside messages",
    state,
  );
  assert(
    state.nestedSubagentCards === 0,
    "nested subagent cards are rendered inside messages",
    state,
  );
  assert(
    state.subagentActivityCards === 0,
    "nested subagent transcripts should render as tracks, not activity cards",
    state,
  );
  assert(
    navChildIds.length === 2 && new Set(navChildIds).size === 2,
    "nested repeat did not expose distinct child subagent navigation options",
    state,
  );
  assert(
    state.tracks.length === 3 &&
      state.workspace.mainStreamCount === 1 &&
      state.workspace.subagentPanelCount === 2 &&
      state.workspace.openPanelCount === 2 &&
      childTrackIds.length === 1 &&
      childTrackIds[0] === selectedAgentId,
    "nested repeat should render main plus the selected child panel and its parent panel",
    state,
  );
  assert(
    state.connectors.length === 2 &&
      state.connectors.every(hasAlignedConnector),
    "nested connectors do not align first messages to parent messages",
    state,
  );
  assert(
    state.mainContentAgentFilters === 0,
    "nested main content should not render an agent selector",
    state,
  );
  assert(
    state.agentFilters.length === 1 &&
      state.agentFilters[0].options.length === 4 &&
      state.agentFilters[0].options.filter((option) => option.active).length ===
        1,
    "nested sidebar agent filter did not expose exactly one selected track",
    state,
  );
  assert(
    state.selectedAgentChips.length === 2 &&
      state.selectedAgentChips.some((chip) => chip.agentId === selectedAgentId),
    "nested selected child should open both parent and child sidebar chips",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "nested tool results should not render in a bottom activity stream",
    state,
  );
  assert(
    state.rows.length === 1 &&
      state.rows[0].agentId === selectedAgentId &&
      state.rows[0].messageIndex === "0",
    "nested sidebar is not scoped to the selected child subagent stream",
    state,
  );
  assert(
    state.activeRows.length === 1 &&
      state.activeRows[0].agentId === selectedAgentId &&
      state.activeRows[0].messageIndex === "0",
    "nested repeat click did not activate exactly the clicked row",
    state,
  );
  assert(
    state.toolActivities.some((activity) =>
      activity.text.includes("parent done"),
    ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("child A done"),
      ) &&
      state.toolActivities.some((activity) =>
        activity.text.includes("child B done"),
      ),
    "nested task tool outputs are missing from inline result cards",
    state,
  );
  assert(
    state.toolActivities.every(
      (activity) => activity.insideMessageGroup && !activity.visible,
    ),
    "nested tool results should be hidden inline cards before expansion",
    state,
  );
  assert(
    state.timelineSpacers.length === 0 && state.timelineIdleBreaks.length === 0,
    "nested tracks should not render timestamp-based timeline spacers",
    state,
  );
  assert(
    state.alignmentSpacers.length === 2 &&
      state.alignmentSpacers.every(
        (spacer) =>
          ["aligned", "clamped"].includes(spacer.status) &&
          spacer.connectorHeight > 0,
      ),
    "nested subagent tracks did not record connector-aware alignment spacers",
    state,
  );
  await page.close();
  return state;
}

async function verifyToolBodyIds(browser) {
  const page = await setupPage(browser);
  await runSyntheticSession(page, {
    id: "tool-repeat",
    messages: [
      baseMessage([
        {
          type: "tool",
          tool: "bash",
          state: { title: "first", input: { command: "one" }, output: "one" },
        },
        {
          type: "tool",
          tool: "bash",
          state: { title: "second", input: { command: "two" }, output: "two" },
        },
      ]),
    ],
    subagent_transcripts: [],
  });

  const state = await readIdentityState(page, ".message-item");
  const toolDuplicateIds = duplicateIdsFrom(state.toolBodyIds);
  assert(
    toolDuplicateIds.length === 0,
    "tool output bodies created duplicate ids",
    {
      ...state,
      toolDuplicateIds,
    },
  );
  assert(
    state.toolBodyIds.length === 2,
    "expected both tool output bodies to exist",
    state,
  );
  assert(
    state.nestedActivityCards === 0,
    "tool activities are nested in messages",
    state,
  );
  assert(
    state.toolActivities.length === 2 &&
      state.toolActivities[0].text.includes("one") &&
      state.toolActivities[1].text.includes("two") &&
      state.toolActivities.every(
        (activity) => activity.insideMessageGroup && !activity.visible,
      ),
    "inline tool activities do not include both hidden outputs",
    state,
  );
  assert(
    state.toolRefs.length === 2 &&
      new Set(state.toolRefs.map((ref) => ref.path)).size === 2 &&
      state.toolRefs.every((ref) => ref.hasButton),
    "message tool references do not point at distinct inline result buttons",
    state,
  );
  assert(
    state.activityStreamCount === 0,
    "tool outputs should not render in a bottom activity stream",
    state,
  );
  const toolRows = state.rows.filter((row) => row.activityPath);
  assert(
    toolRows.length === 0,
    "collapsed hidden tool outputs should not leak into left navigation rows",
    state,
  );
  assert(
    state.rows.every(
      (row) => !row.text.includes("one") && !row.text.includes("two"),
    ) &&
      state.toolRefs.every(
        (ref) => !ref.text.includes("one") && !ref.text.includes("two"),
      ),
    "intermediate step navigation rows and cards should not duplicate tool outputs",
    state,
  );

  await page.locator("[data-tool-result-button]").first().click();
  await page.waitForTimeout(100);
  const expandedFromMessage = await readIdentityState(page, ".message-item");
  const visibleFromMessage = expandedFromMessage.toolActivities.filter(
    (activity) => activity.visible,
  );
  assert(
    visibleFromMessage.length === 1 &&
      visibleFromMessage[0].text.includes("one") &&
      visibleFromMessage[0].insideMessageGroup,
    "message tool result button did not reveal exactly one inline result",
    expandedFromMessage,
  );
  assert(
    expandedFromMessage.activeRows.length === 1 &&
      expandedFromMessage.activeRows[0].activityPath === "msg0__tool0-bash" &&
      expandedFromMessage.rows.filter((row) => row.activityPath).length === 1,
    "expanding one inline tool result should insert and activate its left navigation row",
    expandedFromMessage,
  );

  await page.locator("[data-tool-result-button]").nth(1).click();
  await page.waitForTimeout(100);
  const expandedFromSecondMessage = await readIdentityState(
    page,
    ".message-item",
  );
  assert(
    expandedFromSecondMessage.rows.filter((row) => row.activityPath).length ===
      2 &&
      expandedFromSecondMessage.activeRows.length === 1 &&
      expandedFromSecondMessage.activeRows[0].activityPath ===
        "msg0__tool1-bash",
    "expanding a second inline tool result should activate the second result row without injecting rows",
    expandedFromSecondMessage,
  );

  const visibleAfterSecondInsert =
    expandedFromSecondMessage.toolActivities.filter(
      (activity) => activity.visible,
    );
  assert(
    visibleAfterSecondInsert.length === 2 &&
      visibleAfterSecondInsert.some((activity) =>
        activity.text.includes("one"),
      ) &&
      visibleAfterSecondInsert.some((activity) =>
        activity.text.includes("two"),
      ),
    "inline tool result buttons did not reveal both tool results",
    expandedFromSecondMessage,
  );
  await page
    .locator('.message-item[data-activity-path="msg0__tool0-bash"]')
    .click();
  await page.waitForTimeout(100);
  const expandedFromSidebar = await readIdentityState(page, ".message-item");
  assert(
    expandedFromSidebar.activeRows.length === 1 &&
      expandedFromSidebar.activeRows[0].activityPath === "msg0__tool0-bash" &&
      expandedFromSidebar.toolActivities.some(
        (activity) => activity.path === "msg0__tool0-bash" && activity.visible,
      ),
    "left navigation tool result row did not reveal and activate the linked result",
    expandedFromSidebar,
  );
  await page.locator('[data-tool-result-button="msg0__tool1-bash"]').click();
  await page.waitForTimeout(100);
  const collapsedSecondResult = await readIdentityState(page, ".message-item");
  assert(
    collapsedSecondResult.rows.filter((row) => row.activityPath).length === 1 &&
      collapsedSecondResult.activeRows.length === 0 &&
      collapsedSecondResult.toolActivities.filter(
        (activity) => activity.visible,
      ).length === 1,
    "collapsing an inline tool result should remove its left navigation row",
    collapsedSecondResult,
  );
  await page.close();
  return collapsedSecondResult;
}

async function verifyConnectorAlignmentAfterExpansion(browser) {
  const page = await setupPage(browser);
  const firstTranscript = {
    task_part_id: "first-task",
    agent_type: "general",
    summary: { id: "first-session", title: "First transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "first answer" }],
        "stop",
        "2026-06-18T00:01:00Z",
      ),
    ],
    subagent_transcripts: [],
  };
  const secondTranscript = {
    task_part_id: "second-task",
    agent_type: "general",
    summary: { id: "second-session", title: "Second transcript" },
    messages: [
      baseMessage(
        [{ type: "text", text: "second answer" }],
        "stop",
        "2026-06-18T00:03:00Z",
      ),
    ],
    subagent_transcripts: [],
  };

  await runSyntheticSession(page, {
    id: "connector-realignment",
    messages: [
      baseMessage(
        [taskPart("first-task", "first-session", "first")],
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
      baseMessage(
        [taskPart("second-task", "second-session", "second")],
        "tool-calls",
        "2026-06-18T00:02:00Z",
      ),
    ],
    subagent_transcripts: [firstTranscript, secondTranscript],
  });

  const subagentOptions = page.locator(
    '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
  );
  await subagentOptions.nth(0).click();
  await subagentOptions.nth(1).click();
  await page.waitForTimeout(100);

  const beforeExpansion = await readIdentityState(page, ".message-item");
  const firstToolButton = page
    .locator('[data-tool-result-button="msg0__tool0-first-task"]')
    .first();
  await firstToolButton.click();
  await page.waitForTimeout(100);
  const afterExpansion = await readIdentityState(page, ".message-item");

  assert(
    beforeExpansion.connectors.length === 2 &&
      beforeExpansion.connectors.every(hasAlignedConnector),
    "connectors should align before inline tool expansion",
    beforeExpansion,
  );
  assert(
    afterExpansion.connectors.length === 2 &&
      afterExpansion.connectors.every(hasAlignedConnector),
    "connectors should realign after inline tool expansion changes card heights",
    afterExpansion,
  );
  assert(
    afterExpansion.timelineSpacers.length === 0 &&
      afterExpansion.timelineIdleBreaks.length === 0,
    "connector realignment should not reintroduce timestamp timeline spacers",
    afterExpansion,
  );
  assert(
    afterExpansion.alignmentSpacers.every(
      (spacer) =>
        ["aligned", "clamped"].includes(spacer.status) &&
        spacer.connectorHeight > 0,
    ),
    "alignment spacers should record connector-aware measurements after expansion",
    afterExpansion,
  );

  await page.close();
  return { beforeExpansion, afterExpansion };
}

async function verifyAgentFilterScrollPreserved(browser) {
  const page = await setupPage(browser);
  const transcripts = Array.from({ length: 18 }, (_, index) => ({
    task_part_id: `task-${index}`,
    agent_type: "general",
    summary: {
      id: `session-${index}`,
      title: `Long selector transcript ${index + 1}`,
    },
    messages: [
      baseMessage(
        [{ type: "text", text: `answer ${index + 1}` }],
        "stop",
        `2026-06-18T00:${String(index + 1).padStart(2, "0")}:00Z`,
      ),
    ],
    subagent_transcripts: [],
  }));

  await runSyntheticSession(page, {
    id: "wide-agent-filter",
    messages: [
      baseMessage(
        transcripts.map((transcript, index) =>
          taskPart(
            `task-${index}`,
            transcript.summary.id,
            `prompt ${index + 1}`,
          ),
        ),
        "tool-calls",
        "2026-06-18T00:00:00Z",
      ),
    ],
    subagent_transcripts: transcripts,
  });

  const filter = page.locator(
    '.agent-filter[data-agent-filter-location="sidebar"]',
  );
  await filter.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  const beforeClick = await filter.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    maxScrollLeft: Math.max(0, el.scrollWidth - el.clientWidth),
  }));

  const lastSubagentOption = page
    .locator(
      '.agent-filter[data-agent-filter-location="sidebar"] .agent-filter-option[data-track-kind="subagent"]',
    )
    .last();
  const selectedAgentId =
    await lastSubagentOption.getAttribute("data-agent-id");
  await lastSubagentOption.click();
  await page.waitForTimeout(100);

  const state = await readIdentityState(page, ".message-item");
  const sidebarFilter = state.agentFilters.find(
    (agentFilter) => agentFilter.location === "sidebar",
  );

  assert(
    beforeClick.scrollLeft > 0 && beforeClick.maxScrollLeft > 0,
    "agent filter fixture did not create horizontal overflow",
    { beforeClick, state },
  );
  assert(
    sidebarFilter?.scrollLeft >= beforeClick.scrollLeft - 2,
    "selecting a far-right subagent reset the horizontal agent filter scroll",
    { beforeClick, state },
  );
  assert(
    sidebarFilter?.options.some(
      (option) => option.agentId === selectedAgentId && option.active,
    ),
    "far-right subagent option was not selected after click",
    { selectedAgentId, state },
  );

  await page.close();
  return { beforeClick, afterClick: sidebarFilter, selectedAgentId };
}

const browser = await chromium.launch({ headless: true });
try {
  const results = {
    agentStreamPresentation: await verifyAgentStreamPresentation(browser),
    separatorHiddenWhenPanelCannotLayout:
      await verifySeparatorHiddenWhenPanelCannotLayout(browser),
    repeatedTopLevelTranscript: await verifyRepeatedTopLevelTranscript(browser),
    repeatedNestedTranscript: await verifyRepeatedNestedTranscript(browser),
    toolBodyIds: await verifyToolBodyIds(browser),
    connectorAlignmentAfterExpansion:
      await verifyConnectorAlignmentAfterExpansion(browser),
    agentFilterScrollPreserved: await verifyAgentFilterScrollPreserved(browser),
  };
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} catch (error) {
  console.error(error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
