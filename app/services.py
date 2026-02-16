import json
import sqlite3
import sys

from datetime import datetime
from pathlib import Path


def get_storage_path() -> Path:
    """Get the OpenCode storage path."""
    return Path.home() / ".local/share/opencode/storage"


def load_json(path: Path) -> dict:
    """Load a JSON file."""
    with open(path) as f:
        return json.load(f)


def list_sessions_from_db(db_path: Path) -> list[dict]:
    """List all sessions from the SQLite database."""
    if not db_path.exists():
        return []

    sessions = []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cursor = conn.cursor()

        # Get all sessions
        cursor.execute("""
            SELECT id, title, directory, version, project_id, time_created, time_updated, 
                   summary_additions, summary_deletions, summary_files, parent_id
            FROM session
        """)
        session_rows = cursor.fetchall()

        for row in session_rows:
            session_id = row[0]
            model_info = "Unknown"

            try:
                # Find first message with model info
                cursor.execute(
                    "SELECT data FROM message WHERE session_id = ? AND data LIKE '%modelID%' LIMIT 1",
                    (session_id,),
                )
                msg_row = cursor.fetchone()
                if msg_row:
                    msg_data = json.loads(msg_row[0])
                    # Handle both nested model object and flat modelID field if exists
                    model_info = (
                        msg_data.get("model", {}).get("modelID")
                        or msg_data.get("modelID")
                        or "Unknown"
                    )
            except:
                pass

            sessions.append(
                {
                    "id": row[0],
                    "title": row[1],
                    "directory": row[2],
                    "version": row[3],
                    "projectID": row[4],
                    "time": {"created": row[5], "updated": row[6]},
                    "summary": {
                        "additions": row[7],
                        "deletions": row[8],
                        "files": row[9],
                    },
                    "parent_id": row[10],
                    "model": model_info,
                }
            )

        conn.close()
    except Exception as e:
        print(f"Warning: Failed to load sessions from DB: {e}", file=sys.stderr)
    return sessions


def list_sessions(storage_path: Path, show_all: bool = False) -> list[dict]:
    """List all available sessions with metadata (DB and legacy files)."""
    sessions = []

    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    sessions.extend(list_sessions_from_db(db_path))

    # Try legacy files
    session_base = storage_path / "session"
    if session_base.exists():
        session_ids = {s["id"] for s in sessions}
        # Check all subdirectories (global and project-specific)
        for subdir in session_base.iterdir():
            if subdir.is_dir():
                for session_file in subdir.glob("*.json"):
                    try:
                        data = load_json(session_file)
                        if data.get("id") not in session_ids:
                            sessions.append(data)
                            session_ids.add(data.get("id"))
                    except Exception:
                        continue

    # Sort by last updated time (most recent first)
    sessions.sort(key=lambda s: s.get("time", {}).get("updated", 0), reverse=True)

    if not show_all:
        sessions = [
            s
            for s in sessions
            if s.get("parent_id") is None and "subagent" not in s.get("title", "").lower()
        ]

    return sessions


def format_timestamp(ts: int) -> str:
    """Format a millisecond timestamp to human-readable."""
    if not ts:
        return "Unknown"
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def get_message_parts_from_db(db_path: Path, msg_id: str, session_id: str) -> list[dict]:
    """Load all parts for a message from the SQLite database."""
    if not db_path.exists():
        return []

    parts = []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC",
            (msg_id,),
        )
        for part_id, data_str in cursor.fetchall():
            try:
                part = json.loads(data_str)
                part["id"] = part_id
                part["messageID"] = msg_id
                part["sessionID"] = session_id
                parts.append(part)
            except json.JSONDecodeError:
                continue
        conn.close()
    except Exception as e:
        print(f"Warning: Failed to load parts from DB for {msg_id}: {e}", file=sys.stderr)
    return parts


def get_message_parts(storage_path: Path, msg_id: str) -> list[dict]:
    """Load all parts for a message from legacy files."""
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


def export_session_from_db(db_path: Path, session_id: str) -> dict:
    """Export a session from the SQLite database."""
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cursor = conn.cursor()

        # Verify session exists
        cursor.execute("SELECT id FROM session WHERE id = ?", (session_id,))
        if not cursor.fetchone():
            conn.close()
            raise ValueError(f"Session not found in DB: {session_id}")

        # Load all messages
        messages = []
        cursor.execute(
            "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
            (session_id,),
        )
        message_rows = cursor.fetchall()
        conn.close()

        for msg_id, data_str in message_rows:
            try:
                msg = json.loads(data_str)
                msg["id"] = msg_id
                msg["parts"] = get_message_parts_from_db(db_path, msg_id, session_id)
                messages.append(msg)
            except json.JSONDecodeError:
                continue

        # Sort by creation time (redundant but safe)
        messages.sort(key=lambda m: m.get("time", {}).get("created", 0))

        return {
            "sessionID": session_id,
            "exportedAt": datetime.now().isoformat(),
            "messageCount": len(messages),
            "messages": messages,
        }
    except Exception as e:
        if isinstance(e, ValueError):
            raise
        raise ValueError(f"Failed to export from DB: {e}")


def export_session(storage_path: Path, session_id: str) -> dict:
    """Export a session to a dictionary (DB and legacy files)."""
    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    if db_path.exists():
        try:
            return export_session_from_db(db_path, session_id)
        except ValueError:
            # If not found in DB, fall through to legacy files
            pass

    # Legacy file-based export
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
