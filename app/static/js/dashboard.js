// Dashboard page logic.

// =============================================================================
// DOM refs
// =============================================================================

const searchInput = document.getElementById("searchInput");
const directorySelect = document.getElementById("directorySelect");
const regexCheckbox = document.getElementById("regexCheckbox");
const searchBtn = document.getElementById("searchBtn");
const clearBtn = document.getElementById("clearBtn");
const sessionList = document.getElementById("sessionList");
const searchResultsHeader = document.getElementById("searchResultsHeader");
const searchResultsCount = document.getElementById("searchResultsCount");

// Snapshot of the server-rendered session list, used when clearing search.
const originalContent = sessionList.innerHTML;

// =============================================================================
// Directories
// =============================================================================

async function loadDirectories() {
  try {
    const response = await fetch("/api/directories");
    const directories = await response.json();
    directories.forEach((dir) => {
      const option = document.createElement("option");
      option.value = dir;
      const shortDir = dir.length > 50 ? "..." + dir.slice(-47) : dir;
      option.textContent = shortDir;
      option.title = dir;
      directorySelect.appendChild(option);
    });
  } catch (e) {
    console.error("Failed to load directories:", e);
  }
}

// =============================================================================
// Search
// =============================================================================

regexCheckbox.addEventListener("change", () => {
  searchInput.placeholder = regexCheckbox.checked
    ? "Search with regex pattern..."
    : "Search session contents...";
});

searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") performSearch();
});

async function performSearch() {
  const query = searchInput.value.trim();
  const directory = directorySelect.value;
  const useRegex = regexCheckbox.checked;

  if (!query && !directory) return;

  searchBtn.disabled = true;
  searchBtn.textContent = "Searching...";

  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (directory) params.set("directory", directory);
    if (useRegex) params.set("regex", "true");

    // No query but directory selected — use wildcard for plaintext mode.
    if (!query && directory && !useRegex) params.set("q", "*");

    const response = await fetch("/api/search?" + params.toString());
    const results = await response.json();
    displaySearchResults(results, query, useRegex);
  } catch (e) {
    console.error("Search failed:", e);
    sessionList.innerHTML =
      '<div class="empty-state">Search failed. Please try again.</div>';
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = "Search";
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function displaySearchResults(results, query, useRegex = false) {
  clearBtn.classList.remove("hidden");
  searchResultsHeader.classList.remove("hidden");

  const searchType = useRegex ? "regex" : "plaintext";
  searchResultsCount.textContent = `Found ${results.length} session${results.length !== 1 ? "s" : ""} matching "${query}" (${searchType})`;

  if (results.length === 0) {
    const hint = useRegex
      ? "Check your regex pattern syntax."
      : "Try different search terms.";
    sessionList.innerHTML = `<div class="empty-state">No sessions found matching your search. ${hint}</div>`;
    return;
  }

  sessionList.innerHTML = results
    .map((result) => {
      const title = result.title || "Untitled";
      const directory = result.directory || "";
      const dirShort =
        directory.length > 40 ? "..." + directory.slice(-37) : directory;
      const timeFormatted = result.time_updated
        ? new Date(result.time_updated).toLocaleString()
        : "Unknown";

      const matchesHtml = result.matches
        .map((match) => {
          // Replace <<MATCH>> / <<END>> markers produced by the search backend.
          const snippet = escapeHtml(match.snippet)
            .replace(/&lt;&lt;MATCH&gt;&gt;/g, "<mark>")
            .replace(/&lt;&lt;END&gt;&gt;/g, "</mark>");
          return `
            <div class="match-snippet">
              <div class="match-role">${match.role}</div>
              <div>${snippet}</div>
            </div>
          `;
        })
        .join("");

      const moreMatches =
        result.total_matches > result.matches.length
          ? `<div style="font-size: 12px; color: var(--text-tertiary); margin-top: 8px;">+${result.total_matches - result.matches.length} more matches</div>`
          : "";

      let sessionUrl = `/session/${result.session_id}?q=${encodeURIComponent(query)}`;
      if (useRegex) sessionUrl += "&regex=true";

      return `
        <div class="session-item" data-session-id="${result.session_id}">
          <a href="${sessionUrl}" class="session-item-link">
            <div class="session-header">
              <div class="session-title">${escapeHtml(title)}</div>
              <div class="session-time">${timeFormatted}</div>
            </div>
            <div class="session-meta">
              <div class="meta-item">
                <span>📂</span>
                <span class="directory" title="${escapeHtml(directory)}">${escapeHtml(dirShort)}</span>
              </div>
              <div class="meta-item session-id-copy" data-session-id="${result.session_id}" onclick="copySessionCommand(this, event)" title="Click to copy opencode command">
                <span style="color: var(--text-tertiary)">ID: ${result.session_id}</span>
              </div>
            </div>
            ${matchesHtml}
            ${moreMatches}
          </a>
          <a href="#" class="archive-link" onclick="archiveSession('${result.session_id}', event)">Archive</a>
        </div>
      `;
    })
    .join("");
}

function clearSearch() {
  searchInput.value = "";
  directorySelect.value = "";
  regexCheckbox.checked = false;
  searchInput.placeholder = "Search session contents...";
  sessionList.innerHTML = originalContent;
  clearBtn.classList.add("hidden");
  searchResultsHeader.classList.add("hidden");
}

// =============================================================================
// Copy session command
// =============================================================================

function copySessionCommand(el, event) {
  event.preventDefault();
  event.stopPropagation();

  const sessionId = el.dataset.sessionId;
  navigator.clipboard.writeText(`opencode -s ${sessionId}`).then(() => {
    el.classList.add("copied");
    const span = el.querySelector("span[style]");
    const original = span.textContent;
    span.textContent = "Copied!";
    setTimeout(() => {
      span.textContent = original;
      el.classList.remove("copied");
    }, 1500);
  });
}

// =============================================================================
// Archive
// =============================================================================

async function archiveSession(sessionId, event) {
  event.preventDefault();
  event.stopPropagation();

  const link = event.target;
  link.textContent = "Archiving...";
  link.style.pointerEvents = "none";

  try {
    const response = await fetch(`/api/session/${sessionId}/archive`, {
      method: "POST",
    });

    if (response.ok) {
      const item = link.closest(".session-item");
      item.style.opacity = "0";
      item.style.transform = "translateX(-20px)";
      item.style.transition = "all 0.3s ease";
      setTimeout(() => item.remove(), 300);
    } else {
      link.textContent = "Archive";
      link.style.pointerEvents = "";
      console.error("Failed to archive session");
    }
  } catch (e) {
    link.textContent = "Archive";
    link.style.pointerEvents = "";
    console.error("Failed to archive:", e);
  }
}

// =============================================================================
// Sync
// =============================================================================

async function syncIndex() {
  const btn = document.getElementById("syncBtn");
  btn.disabled = true;
  btn.textContent = "Syncing...";

  try {
    const response = await fetch("/api/sync", { method: "POST" });
    if (response.ok) {
      btn.textContent = "Synced ✓";
      setTimeout(() => window.location.reload(), 800);
    } else {
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = "Sync";
        btn.disabled = false;
      }, 2000);
    }
  } catch (e) {
    console.error("Sync failed:", e);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = "Sync";
      btn.disabled = false;
    }, 2000);
  }
}

// =============================================================================
// Init
// =============================================================================

loadDirectories();
