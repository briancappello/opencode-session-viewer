# OpenCode Session Viewer

A standalone HTML viewer for browsing OpenCode session logs. View your AI coding conversations with a clean timeline interface, token usage visualizations, and easy navigation.

## Quick start

### 1. Export your session data

Run the export script directly from GitHub (you can inspect it first for security):

```bash
uv run https://raw.githubusercontent.com/ericmjl/opencode-session-viewer/main/export_session.py
```

This will interactively list your recent OpenCode sessions and let you choose one to export.

**Or ask OpenCode to do it for you!** Paste this prompt:

> Export your current session logs by running:
> `uv run https://raw.githubusercontent.com/ericmjl/opencode-session-viewer/main/export_session.py`
> Then tell me where the session_data.json file was saved.

### 2. View the session

Option A: Open the hosted viewer and load your JSON file:
- Go to the GitHub Pages site (if enabled) or open `index.html` locally

Option B: Clone and run locally:
```bash
git clone https://github.com/ericmjl/opencode-session-viewer.git
cd opencode-session-viewer
# Copy your session_data.json here, then:
open index.html
```

## Export script options

```bash
# Interactive mode (recommended)
uv run export_session.py

# List all available sessions
uv run export_session.py --list

# Export a specific session by ID
uv run export_session.py ses_abc123...

# Custom output filename
uv run export_session.py --output my_session.json
```

## Features

- **Timeline view**: Scroll through your entire conversation
- **Sidebar navigation**: Click to jump to any message
- **Token visualization**: See input/output/cache tokens for each message
- **Cache sparkline**: Track cache usage over the session
- **Search & filter**: Find messages by content or filter by role
- **Dark mode**: Toggle with the 🌓 button
- **Collapsible tool calls**: Expand to see tool inputs/outputs

## How it works

OpenCode stores session data in `~/.local/share/opencode/storage/`:
- `session/` - Session metadata (title, directory, timestamps)
- `message/<session_id>/` - Message metadata for each session
- `part/<message_id>/` - Message content (text, tool calls, token counts)

The export script consolidates these into a single JSON file that the viewer can display.

## Privacy

- All data stays local - the viewer runs entirely in your browser
- Session data is never uploaded anywhere
- You can inspect the export script before running it

## License

MIT
