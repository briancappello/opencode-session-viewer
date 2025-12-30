# OpenCode Session Viewer

A standalone HTML viewer for browsing OpenCode session logs. View your AI coding conversations with a clean timeline interface, token usage visualizations, and easy navigation.

## Quick start

### 1. Export your session data

**Ask OpenCode to do it for you!** Copy and paste this prompt:

> Find this session's ID from OpenCode's storage, then export it by running the script at https://raw.githubusercontent.com/ericmjl/opencode-session-viewer/main/export_session.py (inspect the contents first). Export it as session_data.json in the current directory.

Or run the export script manually:

```bash
uv run https://raw.githubusercontent.com/ericmjl/opencode-session-viewer/main/export_session.py
```

This will interactively list your recent OpenCode sessions and let you choose one to export.

### 2. View the session

**Option A:** Use the hosted viewer at https://ericmjl.github.io/opencode-session-viewer/
- Upload your `session_data.json` file, or
- Paste a URL to a hosted JSON file

**Option B:** Clone and run locally:
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
