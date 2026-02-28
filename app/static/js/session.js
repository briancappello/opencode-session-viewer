// Session Viewer JavaScript
// This file contains all the client-side logic for the session detail page

let SESSION_DATA = null;
let currentFilter = "all";
let searchQuery = "";
let toolCounter = 0;
let highlightedId = null;
let tokenData = [];
let maxTokens = { input: 1, output: 1, cache: 1 };
let currentMessageIndex = 0;
let urlSearchQuery = ""; // Search query from URL (for highlighting)

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

// Get preview
function getPreview(msg) {
  const textPart = msg.parts?.find((p) => p.type === "text");
  if (textPart?.text) {
    // Return first paragraph (split by double newline or newline)
    const text = textPart.text.trim();
    const firstPara = text.split(/\n\s*\n/)[0];
    return firstPara.length > 300
      ? firstPara.substring(0, 300) + "..."
      : firstPara;
  }
  const toolPart = msg.parts?.find((p) => p.type === "tool");
  if (toolPart) return `[${toolPart.tool}]`;
  return msg.summary?.title || "";
}

// Get full text content of a message for searching
function getFullText(msg) {
  let text = "";
  (msg.parts || []).forEach((p) => {
    if (p.type === "text" && p.text) {
      text += p.text + " ";
    }
  });
  return text.toLowerCase();
}

// Highlight search terms in text
function highlightText(text, query) {
  if (!query) return esc(text);

  // Escape the text first
  const escaped = esc(text);

  // Create a case-insensitive regex for the search term
  // Escape regex special characters in the query
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");

  return escaped.replace(regex, "<mark>$1</mark>");
}

// Get a snippet around the search match
function getMatchSnippet(msg, query) {
  if (!query) return null;

  const textPart = msg.parts?.find((p) => p.type === "text" && p.text);
  if (!textPart?.text) return null;

  const text = textPart.text;
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

// Toggle tool
function toggleTool(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle("expanded");
    // Apply syntax highlighting to code blocks with explicit language classes
    if (el.classList.contains("expanded")) {
      el.querySelectorAll('pre code[class*="language-"]:not(.hljs)').forEach(
        (block) => {
          hljs.highlightElement(block);
        },
      );
    }
  }
}

// Scroll to message
function scrollToMessage(idx) {
  const el = document.getElementById("msg-" + idx);
  if (el) {
    if (highlightedId !== null) {
      document
        .getElementById("msg-" + highlightedId)
        ?.classList.remove("highlighted");
    }

    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("highlighted");
    highlightedId = idx;

    document.querySelectorAll(".message-item").forEach((item) => {
      item.classList.toggle("active", parseInt(item.dataset.index) === idx);
    });

    updateViz(idx);

    setTimeout(() => {
      el.classList.remove("highlighted");
    }, 2000);
  }
}

// Detect visible message on scroll
function detectVisibleMessage() {
  if (!SESSION_DATA) return;

  const mainContent = document.getElementById("mainContent");
  const scrollTop = mainContent.scrollTop;
  const viewportHeight = mainContent.clientHeight;
  const viewportCenter = scrollTop + viewportHeight / 3;

  let closestIdx = 0;
  let closestDist = Infinity;

  SESSION_DATA.messages.forEach((_, i) => {
    const el = document.getElementById("msg-" + i);
    if (el) {
      const elTop = el.offsetTop;
      const dist = Math.abs(elTop - viewportCenter);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    }
  });

  if (closestIdx !== currentMessageIndex) {
    updateViz(closestIdx);

    document.querySelectorAll(".message-item").forEach((item) => {
      item.classList.toggle(
        "active",
        parseInt(item.dataset.index) === closestIdx,
      );
    });
  }
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
    .writeText(markdown.trim())
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
function renderSidebar() {
  if (!SESSION_DATA) return;

  // Determine which search query to use for filtering
  const activeSearch = searchQuery || urlSearchQuery;

  const filtered = SESSION_DATA.messages.filter((m, i) => {
    if (currentFilter !== "all" && m.role !== currentFilter) return false;

    const preview = getPreview(m);
    // Filter out bracketed previews like [bash], [edit], etc.
    if (/^\[.*?\]$/.test(preview.trim())) return false;

    if (activeSearch) {
      // Search in full message text, not just preview
      const fullText = getFullText(m);
      if (!fullText.includes(activeSearch.toLowerCase())) return false;
    }
    return true;
  });

  const list = document.getElementById("messageList");
  list.innerHTML = filtered
    .map((m) => {
      const idx = SESSION_DATA.messages.indexOf(m);

      // Determine what to show as preview
      let previewHtml;
      if (activeSearch) {
        // Try to get a snippet around the match
        const snippet = getMatchSnippet(m, activeSearch);
        if (snippet) {
          previewHtml = highlightText(snippet, activeSearch);
        } else {
          previewHtml = highlightText(getPreview(m), activeSearch);
        }
      } else {
        previewHtml = esc(getPreview(m));
      }

      return `
                <div class="message-item" data-index="${idx}" onclick="scrollToMessage(${idx})">
                    <div class="message-item-header">
                        <span class="role-badge ${m.role}">${m.role}</span>
                        <span class="message-time">${formatTime(m.time_created)}</span>
                    </div>
                    <div class="message-preview">${previewHtml}</div>
                </div>
            `;
    })
    .join("");
}

// Render search indicator when URL has search query
function renderSearchIndicator() {
  const container = document.querySelector(".filter-row");
  const existingIndicator = document.querySelector(".search-active-indicator");

  if (existingIndicator) {
    existingIndicator.remove();
  }

  if (urlSearchQuery && !searchQuery) {
    const indicator = document.createElement("div");
    indicator.className = "search-active-indicator";
    indicator.innerHTML = `
            <span>Filtered by: "${esc(urlSearchQuery)}"</span>
            <button class="clear-search" onclick="clearUrlSearch()" title="Clear search filter">×</button>
        `;
    container.parentNode.insertBefore(indicator, container.nextSibling);
  }
}

// Clear URL search and show all messages
function clearUrlSearch() {
  urlSearchQuery = "";
  // Update URL without the query parameter
  const url = new URL(window.location);
  url.searchParams.delete("q");
  window.history.replaceState({}, "", url);

  renderSearchIndicator();
  renderSidebar();
}

// Render part
function renderPart(part) {
  // Check for reasoning types
  const isReasoning =
    (part.type === "reasoning" && part.text) ||
    (part.type === "tool" &&
      part.tool === "task" &&
      part.state?.input?.subagent_type);

  if (isReasoning) {
    // Determine content based on reasoning type
    let content = "";
    let label = "";

    if (part.type === "reasoning") {
      label = "Thinking Process";
      content = DOMPurify.sanitize(marked.parse(part.text));
    } else {
      // It's a subtask (tool call)
      const st = part.state || {};
      const prompt = st.input?.prompt || st.input?.description || "";
      const result = st.output || "";
      const subagent = st.input?.subagent_type || "task";

      label = `Subtask: ${subagent}`;

      // Format subtask content
      const resultText =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      content = `
                <div class="subtask-prompt"><strong>Task:</strong> ${esc(prompt)}</div>
                ${result ? `<div class="subtask-result">${DOMPurify.sanitize(marked.parse(resultText))}</div>` : ""}
            `;
    }

    return `
            <div class="part part-reasoning">
                <div class="reasoning-label"><span>${part.type === "reasoning" ? "🧠" : "🤖"}</span> ${label}</div>
                <div class="part-text">${content}</div>
            </div>
        `;
  }

  if (part.type === "text" && part.text) {
    // Skip synthetic text parts (these are tool call echoes that shouldn't be rendered as text)
    if (part.synthetic) {
      return "";
    }
    // Parse markdown and sanitize HTML
    const cleanHtml = DOMPurify.sanitize(marked.parse(part.text));
    return `<div class="part"><div class="part-text">${cleanHtml}</div></div>`;
  }

  if (part.type === "tool") {
    // If this was handled as reasoning/subtask, skip it here
    const isSubtask = part.tool === "task" && part.state?.input?.subagent_type;
    if (isSubtask) return "";

    const st = part.state || {};
    const id = "tool-" + toolCounter++;
    const outputText = st.output
      ? typeof st.output === "string"
        ? st.output
        : JSON.stringify(st.output, null, 2)
      : "";

    // Determine if this tool should have syntax highlighting
    // File operations (read, write, edit, glob, grep) should NOT have highlighting
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
    const toolName = (part.tool || "").toLowerCase();
    const skipHighlight = noHighlightTools.some((t) => toolName.includes(t));

    // Only apply JSON highlighting to input if it's not a file operation tool
    const inputLangClass = skipHighlight ? "" : "language-json";

    return `
            <div class="part part-tool">
                <div class="tool-header" onclick="toggleTool('${id}')">
                    <span>
                        <span class="tool-name">${esc(part.tool)}</span>
                        <span class="tool-summary">${esc(st.title || "")}</span>
                    </span>
                    <span class="tool-status">${st.status || ""}</span>
                </div>
                <div class="tool-body" id="${id}">
                    ${
                      st.input
                        ? `
                        <div class="tool-section">
                            <div class="tool-section-label">Input</div>
                            <pre class="tool-code"><code class="${inputLangClass}">${esc(JSON.stringify(st.input, null, 2))}</code></pre>
                        </div>
                    `
                        : ""
                    }
                    ${
                      st.output
                        ? `
                        <div class="tool-section">
                            <div class="tool-section-label">Output</div>
                            <pre class="tool-code"><code>${esc(outputText)}</code></pre>
                        </div>
                    `
                        : ""
                    }
                </div>
            </div>
        `;
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

// Render timeline
function renderTimeline() {
  if (!SESSION_DATA) return;

  toolCounter = 0;
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = SESSION_DATA.messages
    .filter((m) => !/^\[.*?\]$/.test(getPreview(m).trim()))
    .map((m, i) => {
      // We need to use the original index to keep links working
      const originalIdx = SESSION_DATA.messages.indexOf(m);
      return `
                <div class="message ${m.role}" id="msg-${originalIdx}">
                    <div class="message-header">
                        <div class="message-header-left">
                            <span class="role-badge ${m.role}">${m.role}</span>
                            <span class="message-meta">
                                <span>${formatFullTime(m.time_created)}</span>
                                ${m.modelID ? `<span>${m.modelID}</span>` : ""}
                                ${m.agent ? `<span>${m.agent}</span>` : ""}
                            </span>
                        </div>
                        <button class="copy-btn" onclick="copyMarkdown(${originalIdx})" title="Copy markdown to clipboard">
                            <span>📋</span> Copy
                        </button>
                    </div>
                    <div class="message-body">
                        ${(m.parts || []).map((p) => renderPart(p)).join("") || '<span style="color:var(--text-tertiary)">(no content)</span>'}
                    </div>
                </div>
            `;
    })
    .join("");

  // Apply syntax highlighting to all code blocks
  applySyntaxHighlighting();
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
  document.getElementById("stats").innerHTML = `
        <span>${total} total</span>
        <span>${user} user</span>
        <span>${asst} assistant</span>
    `;
}

// Load data
function loadData(data) {
  SESSION_DATA = data;

  // Initialize URL search query
  urlSearchQuery = getUrlSearchQuery();
  if (urlSearchQuery) {
    // Pre-populate the search box with the query
    document.getElementById("searchBox").value = urlSearchQuery;
  }

  buildTokenData();
  updateStats();
  renderSearchIndicator();
  renderSidebar();
  renderTimeline();
  updateViz(0);

  // Add scroll listener
  document
    .getElementById("mainContent")
    .addEventListener("scroll", detectVisibleMessage);

  // Navbar hide/show on scroll
  const navbar = document.getElementById("topNavbar");
  const container = document.querySelector(".container");
  const mainContent = document.getElementById("mainContent");
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
      `/api/session/${SESSION_DATA.summary.id}/archived`,
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
    btn.title = "Unarchive this session";
  } else {
    btn.textContent = "Archive";
    btn.classList.remove("archived");
    btn.title = "Archive this session";
  }
}

async function toggleArchive() {
  if (!SESSION_DATA) return;

  const btn = document.getElementById("archiveBtn");
  btn.disabled = true;

  try {
    const action = isArchived ? "unarchive" : "archive";
    const response = await fetch(
      `/api/session/${SESSION_DATA.summary.id}/${action}`,
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
function initSession() {
  // Initialize sidebar resize
  initSidebarResize();

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

  // Set up search
  document.getElementById("searchBox").addEventListener("input", (e) => {
    searchQuery = e.target.value.toLowerCase();

    // If user clears the search box, restore URL search behavior
    if (!searchQuery && urlSearchQuery) {
      renderSearchIndicator();
    } else if (searchQuery) {
      // Hide the URL search indicator when user is typing
      const indicator = document.querySelector(".search-active-indicator");
      if (indicator) indicator.remove();
    }

    renderSidebar();
  });

  // Resize handler for sparkline
  window.addEventListener("resize", () => {
    renderSparkline();
  });

  // Load data from script tag
  try {
    const jsonText = document.getElementById("session-data").textContent;
    const INITIAL_DATA = JSON.parse(jsonText);
    if (INITIAL_DATA) {
      loadData(INITIAL_DATA);
      // Check archive status after loading
      checkArchiveStatus();
    }
  } catch (e) {
    console.error("Failed to parse session data:", e);
  }
}

// Run initialization when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSession);
} else {
  initSession();
}
