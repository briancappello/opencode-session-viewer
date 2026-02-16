import json
import sys

from datetime import datetime
from pathlib import Path
from typing import List, Optional

from sqlalchemy import select

from app.db import MessageModel, SessionModel, get_db_session
from app.models import (
    Message,
    SessionExport,
    SessionSummary,
)


def get_storage_path() -> Path:
    """Get the OpenCode storage path."""
    return Path.home() / ".local/share/opencode/storage"


def load_json(path: Path) -> dict:
    """Load a JSON file."""
    with open(path) as f:
        return json.load(f)


def list_sessions_from_db(db_path: Path) -> List[SessionSummary]:
    """List all sessions from the SQLite database."""
    if not db_path.exists():
        return []

    results = []
    try:
        # Use SQLAlchemy session
        with get_db_session(db_path) as db:
            # Query sessions
            stmt = select(SessionModel)
            sessions = db.scalars(stmt).all()

            for s in sessions:
                # Fetch model name
                model_name = "Unknown"
                msg = db.scalars(
                    select(MessageModel)
                    .where(MessageModel.session_id == s.id)
                    .where(MessageModel.data.like("%modelID%"))
                    .limit(1)
                ).first()

                if msg:
                    try:
                        msg_data = json.loads(msg.data)
                        model_name = (
                            msg_data.get("model", {}).get("modelID")
                            or msg_data.get("modelID")
                            or "Unknown"
                        )
                    except:
                        pass

                # Convert using from_attributes
                summary = SessionSummary.model_validate(s)
                summary.model = model_name

                results.append(summary)

    except Exception as e:
        print(f"Warning: Failed to load sessions from DB: {e}", file=sys.stderr)
    return results


def list_sessions_from_files(storage_path: Path) -> List[SessionSummary]:
    """List sessions from legacy JSON files."""
    results = []
    session_base = storage_path / "session"

    if not session_base.exists():
        return results

    # Check all subdirectories (global and project-specific)
    for subdir in session_base.iterdir():
        if subdir.is_dir():
            for session_file in subdir.glob("*.json"):
                try:
                    data = load_json(session_file)
                    data = _transform_legacy_session(data)
                    # Convert dict to Pydantic
                    summary = SessionSummary.model_validate(data)
                    # Legacy files usually don't have the model name easily accessible
                    results.append(summary)
                except Exception:
                    continue
    return results


def list_sessions(storage_path: Path, show_all: bool = False) -> List[SessionSummary]:
    """List all available sessions (DB and legacy files)."""
    sessions_map = {}  # Map ID to session to avoid duplicates

    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    for s in list_sessions_from_db(db_path):
        sessions_map[s.id] = s

    # Try legacy files
    for s in list_sessions_from_files(storage_path):
        if s.id not in sessions_map:
            sessions_map[s.id] = s

    # Sort by last updated time (most recent first)
    sorted_sessions = sorted(
        sessions_map.values(), key=lambda s: s.time_updated or 0, reverse=True
    )

    if not show_all:
        sorted_sessions = [
            s
            for s in sorted_sessions
            if s.parent_id is None and "subagent" not in (s.title or "").lower()
        ]

    return sorted_sessions


def format_timestamp(ts: Optional[int]) -> str:
    """Format a millisecond timestamp to human-readable."""
    if not ts:
        return "Unknown"
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def export_session_from_db(db_path: Path, session_id: str) -> SessionExport:
    """Export a session from the SQLite database."""
    try:
        with get_db_session(db_path) as db:
            # Check session exists
            session_model = db.get(SessionModel, session_id)
            if not session_model:
                raise ValueError(f"Session not found in DB: {session_id}")

            # Get messages with parts eager loaded
            stmt = (
                select(MessageModel)
                .where(MessageModel.session_id == session_id)
                .order_by(MessageModel.time_created)
            )
            message_models = db.scalars(stmt).all()

            # Pydantic model_validate will use properties on MessageModel to load role, parts, etc.
            messages = [Message.model_validate(m) for m in message_models]

            return SessionExport(
                sessionID=session_id,
                exportedAt=datetime.now().isoformat(),
                messageCount=len(messages),
                messages=messages,
            )

    except Exception as e:
        if isinstance(e, ValueError):
            raise
        raise ValueError(f"Failed to export from DB: {e}")


def export_session_from_files(storage_path: Path, session_id: str) -> SessionExport:
    """Export a session from legacy files."""
    message_path = storage_path / "message" / session_id

    if not message_path.exists():
        raise ValueError(f"Session not found: {session_id}")

    messages = []
    for msg_file in message_path.glob("*.json"):
        try:
            msg_data = load_json(msg_file)

            # Load parts
            part_dir = storage_path / "part" / msg_data["id"]
            parts = []
            if part_dir.exists():
                for part_file in sorted(part_dir.glob("*.json")):
                    try:
                        parts.append(load_json(part_file))
                    except:
                        continue

            msg_data["parts"] = parts
            msg_data = _transform_legacy_message(msg_data)

            messages.append(Message.model_validate(msg_data))
        except Exception as e:
            print(f"Warning: Failed to load message {msg_file}: {e}", file=sys.stderr)
            continue

    # Sort by creation time
    messages.sort(key=lambda m: m.time_created or 0)

    return SessionExport(
        sessionID=session_id,
        exportedAt=datetime.now().isoformat(),
        messageCount=len(messages),
        messages=messages,
    )


def load_session_export(storage_path: Path, session_id: str) -> SessionExport:
    """Export a session to a Pydantic model (DB or legacy files)."""
    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    if db_path.exists():
        try:
            return export_session_from_db(db_path, session_id)
        except ValueError:
            pass

    # Legacy file-based export
    return export_session_from_files(storage_path, session_id)


def _transform_legacy_session(data: dict) -> dict:
    """Transform legacy nested JSON to flat structure."""
    if "time" in data and isinstance(data["time"], dict):
        data["time_created"] = data["time"].get("created")
        data["time_updated"] = data["time"].get("updated")

    if "summary" in data and isinstance(data["summary"], dict):
        data["summary_additions"] = data["summary"].get("additions")
        data["summary_deletions"] = data["summary"].get("deletions")
        data["summary_files"] = data["summary"].get("files")
    return data


def _transform_legacy_message(data: dict) -> dict:
    """Transform legacy nested message JSON to flat structure."""
    if "time" in data and isinstance(data["time"], dict):
        data["time_created"] = data["time"].get("created")
        data["time_updated"] = data["time"].get("updated")

    if "parts" in data and isinstance(data["parts"], list):
        for part in data["parts"]:
            if "time" in part and isinstance(part["time"], dict):
                part["time_created"] = part["time"].get("created")
    return data
