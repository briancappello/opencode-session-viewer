# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Export OpenCode session data to JSON for use with the session viewer.

Usage:
    uv run export_session.py                     # Interactive: lists sessions to choose from
    uv run export_session.py <session_id>        # Export specific session
    uv run export_session.py --output out.json   # Specify output file (default: session_data.json)

Or run directly from GitHub:
    uv run https://raw.githubusercontent.com/ericmjl/opencode-session-viewer/main/export_session.py
"""

import json
import sys
from pathlib import Path
from datetime import datetime


def get_storage_path() -> Path:
    """Get the OpenCode storage path."""
    return Path.home() / ".local/share/opencode/storage"


def load_json(path: Path) -> dict:
    """Load a JSON file."""
    with open(path) as f:
        return json.load(f)


def list_sessions(storage_path: Path) -> list[dict]:
    """List all available sessions with metadata."""
    sessions = []
    session_base = storage_path / "session"

    if not session_base.exists():
        return sessions

    # Check all subdirectories (global and project-specific)
    for subdir in session_base.iterdir():
        if subdir.is_dir():
            for session_file in subdir.glob("*.json"):
                try:
                    data = load_json(session_file)
                    sessions.append(data)
                except Exception:
                    continue

    # Sort by last updated time (most recent first)
    sessions.sort(key=lambda s: s.get("time", {}).get("updated", 0), reverse=True)
    return sessions


def format_timestamp(ts: int) -> str:
    """Format a millisecond timestamp to human readable."""
    if not ts:
        return "Unknown"
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def get_message_parts(storage_path: Path, msg_id: str) -> list[dict]:
    """Load all parts for a message."""
    part_dir = storage_path / "part" / msg_id
    if not part_dir.exists():
        return []

    parts = []
    for part_file in sorted(part_dir.glob("*.json")):
        try:
            parts.append(load_json(part_file))
        except Exception:
            continue
    return parts


def export_session(storage_path: Path, session_id: str) -> dict:
    """Export a session to a dictionary."""
    # Find the session's message directory
    message_path = storage_path / "message" / session_id

    if not message_path.exists():
        raise ValueError(f"Session not found: {session_id}")

    # Load all messages
    messages = []
    for msg_file in message_path.glob("*.json"):
        try:
            msg = load_json(msg_file)
            msg["parts"] = get_message_parts(storage_path, msg["id"])
            messages.append(msg)
        except Exception as e:
            print(f"Warning: Failed to load message {msg_file}: {e}", file=sys.stderr)
            continue

    # Sort by creation time
    messages.sort(key=lambda m: m.get("time", {}).get("created", 0))

    return {
        "sessionID": session_id,
        "exportedAt": datetime.now().isoformat(),
        "messageCount": len(messages),
        "messages": messages,
    }


def interactive_select(sessions: list[dict]) -> str | None:
    """Let user interactively select a session."""
    if not sessions:
        print("No sessions found.")
        return None

    print("\nAvailable OpenCode sessions:\n")
    print(f"{'#':<4} {'Updated':<18} {'Dir':<40} {'Title':<50}")
    print("-" * 115)

    for i, session in enumerate(sessions[:30], 1):  # Show max 30
        updated = format_timestamp(session.get("time", {}).get("updated"))
        directory = session.get("directory", "")
        # Shorten directory for display
        if len(directory) > 38:
            directory = "..." + directory[-35:]
        title = session.get("title", "Untitled")[:48]
        print(f"{i:<4} {updated:<18} {directory:<40} {title:<50}")

    print()

    try:
        choice = input("Enter session number (or 'q' to quit): ").strip()
        if choice.lower() == "q":
            return None

        idx = int(choice) - 1
        if 0 <= idx < len(sessions):
            return sessions[idx]["id"]
        else:
            print("Invalid selection.")
            return None
    except (ValueError, KeyboardInterrupt):
        return None


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Export OpenCode session data to JSON",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                           # Interactive session selection
  %(prog)s ses_abc123...             # Export specific session
  %(prog)s --list                    # List all sessions
  %(prog)s --output my_session.json  # Custom output filename
        """,
    )
    parser.add_argument("session_id", nargs="?", help="Session ID to export")
    parser.add_argument(
        "--list", "-l", action="store_true", help="List available sessions"
    )
    parser.add_argument(
        "--output", "-o", default="session_data.json", help="Output filename"
    )

    args = parser.parse_args()

    storage_path = get_storage_path()

    if not storage_path.exists():
        print(f"OpenCode storage not found at {storage_path}", file=sys.stderr)
        sys.exit(1)

    # List sessions
    sessions = list_sessions(storage_path)

    if args.list:
        if not sessions:
            print("No sessions found.")
        else:
            print(f"\nFound {len(sessions)} sessions:\n")
            for session in sessions[:50]:
                updated = format_timestamp(session.get("time", {}).get("updated"))
                print(f"  {session['id']}")
                print(f"    Title: {session.get('title', 'Untitled')}")
                print(f"    Directory: {session.get('directory', 'Unknown')}")
                print(f"    Updated: {updated}")
                print()
        sys.exit(0)

    # Get session ID
    session_id = args.session_id
    if not session_id:
        session_id = interactive_select(sessions)
        if not session_id:
            sys.exit(0)

    # Export
    print(f"Exporting session: {session_id}")

    try:
        data = export_session(storage_path, session_id)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # Write output
    output_path = Path(args.output)
    with open(output_path, "w") as f:
        json.dump(data, f)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(
        f"Exported {data['messageCount']} messages to {output_path} ({size_mb:.1f} MB)"
    )
    print(f"\nTo view: open index.html and load {output_path}")


if __name__ == "__main__":
    main()
