# OpenCode Session Viewer

A standalone HTML viewer for browsing OpenCode session logs. View your AI coding conversations with a clean timeline interface, token usage visualizations, and easy navigation.

This project now includes a **FastAPI web application** for browsing and viewing sessions directly from your local machine, supporting both the new SQLite database storage and legacy JSON files.

## Quick Start

### 1. Install Dependencies

Using `uv`:

```bash
uv sync
```

### 2. Run the Web Dashboard

Start the local server to browse all your sessions:

```bash
uv run uvicorn app.main:app --reload
```

Open **http://127.0.0.1:8000** in your browser.

- **Dashboard:** View all sessions, filter by date, search, toggle subagents.
- **Session Viewer:** Detailed timeline view with markdown rendering, syntax highlighting, and token usage charts.

### 3. CLI Export (Optional)

You can still use the CLI script to export sessions to a JSON file if needed:

```bash
# Interactive mode
uv run export_session.py

# List all sessions
uv run export_session.py --list

# Export specific session
uv run export_session.py ses_abc123...
```

## Features

- **Web Dashboard**: Browse all local sessions with metadata (model, directory, time).
- **SQLite Support**: Reads directly from OpenCode's new SQLite database (`~/.local/share/opencode/opencode.db`).
- **Legacy Support**: Also reads old JSON-based session files.
- **Timeline View**: Scroll through your entire conversation with markdown rendering.
- **Token Visualization**: See input/output/cache tokens for each message.
- **Dark Mode**: Toggle with the 🌓 button.
- **Search & Filter**: Find messages by content or role.
- **Subagent Filtering**: Hide automated subagent sessions to focus on main conversations.
- **Markdown Export**: Copy any message as markdown to your clipboard.

## How it works

OpenCode stores session data in `~/.local/share/opencode/`. The viewer reads from:
1.  **SQLite Database:** `opencode.db` (primary storage for recent sessions).
2.  **Legacy Files:** `storage/session/`, `storage/message/`, `storage/part/` (for older sessions).

The application consolidates data from both sources into a unified interface.

## Privacy

- All data stays local - the viewer runs entirely on your machine.
- No data is uploaded anywhere.

## License

MIT
