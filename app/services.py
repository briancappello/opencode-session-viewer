import json
import re
import sys

from datetime import datetime
from pathlib import Path
from typing import List, Optional

from sqlalchemy import select, text

from app.db import MessageModel, SessionModel, get_db_session
from app.models import (
    Message,
    SearchMatch,
    SearchResult,
    SessionExport,
    SessionSummary,
)
from app.overrides_db import get_session_override
from app.search_db import (
    SEARCH_DB_PATH,
    get_archived_session_ids,
    get_search_session,
)


def get_storage_path() -> Path:
    """Get the OpenCode storage path."""
    return Path.home() / ".local/share/opencode/storage"


def apply_overrides(summary: SessionSummary) -> SessionSummary:
    """Apply any user-defined overrides to a SessionSummary.

    Fetches the override row for this session and replaces fields where an
    override value is set (non-None).  The canonical ``id`` is never changed.
    Returns the same object mutated in place for convenience.
    """
    override = get_session_override(summary.id)
    if override is None:
        return summary
    if override.title is not None:
        summary.title = override.title
    if override.human_id is not None:
        summary.human_id = override.human_id
    return summary


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
                summary.source = "db"

                results.append(summary)

    except Exception as e:
        print(f"Warning: Failed to load sessions from DB: {e}", file=sys.stderr)
    return results


def get_session_summary_from_files(
    storage_path: Path, session_id: str
) -> SessionSummary | None:
    try:
        return [
            session
            for session in list_sessions_from_files(storage_path)
            if session.id == session_id
        ][0]
    except IndexError:
        return None


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
                    summary.source = "files"
                    results.append(summary)
                except Exception:
                    continue

    return results


def list_sessions(storage_path: Path, show_all: bool = False) -> List[SessionSummary]:
    """List all available sessions (DB and legacy files), excluding archived."""
    sessions_map = {}  # Map ID to session to avoid duplicates

    # Get archived session IDs to exclude
    archived_ids = get_archived_session_ids()

    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    for s in list_sessions_from_db(db_path):
        if s.id not in archived_ids:
            sessions_map[s.id] = apply_overrides(s)

    # Try legacy files
    for s in list_sessions_from_files(storage_path):
        if s.id not in sessions_map and s.id not in archived_ids:
            sessions_map[s.id] = apply_overrides(s)

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


def list_archived_sessions(storage_path: Path) -> List[SessionSummary]:
    """List archived sessions only."""
    sessions_map = {}  # Map ID to session to avoid duplicates

    # Get archived session IDs
    archived_ids = get_archived_session_ids()

    if not archived_ids:
        return []

    # Try DB first
    db_path = storage_path.parent / "opencode.db"
    for s in list_sessions_from_db(db_path):
        if s.id in archived_ids:
            sessions_map[s.id] = apply_overrides(s)

    # Try legacy files
    for s in list_sessions_from_files(storage_path):
        if s.id not in sessions_map and s.id in archived_ids:
            sessions_map[s.id] = apply_overrides(s)

    # Sort by last updated time (most recent first)
    sorted_sessions = sorted(
        sessions_map.values(), key=lambda s: s.time_updated or 0, reverse=True
    )

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
                summary=SessionSummary.model_validate(session_model),
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
        summary=get_session_summary_from_files(storage_path, session_id),
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


def _escape_fts5_query(query: str) -> str:
    """Escape special FTS5 characters for literal/plaintext search.

    FTS5 special characters that need escaping: " * ( ) : ^
    We wrap the query in double quotes to search for the exact phrase.
    Any internal double quotes are escaped by doubling them.
    """
    # Escape internal double quotes by doubling them
    escaped = query.replace('"', '""')
    # Wrap in double quotes for phrase search (literal matching)
    return f'"{escaped}"'


def _generate_snippet(
    content: str, pattern: re.Pattern, snippet_length: int = 100
) -> str:
    """Generate a snippet with match markers for regex search results.

    Returns a snippet of text around the first match with <<MATCH>> and <<END>>
    markers for highlighting.
    """
    match = pattern.search(content)
    if not match:
        return content[:snippet_length] + ("..." if len(content) > snippet_length else "")

    match_start, match_end = match.span()
    matched_text = match.group()

    # Calculate context window around the match
    context_chars = (snippet_length - len(matched_text)) // 2
    start = max(0, match_start - context_chars)
    end = min(len(content), match_end + context_chars)

    # Build snippet with markers
    prefix = ("..." if start > 0 else "") + content[start:match_start]
    suffix = content[match_end:end] + ("..." if end < len(content) else "")

    return f"{prefix}<<MATCH>>{matched_text}<<END>>{suffix}"


def search_sessions(
    query: str,
    directory: Optional[str] = None,
    limit: int = 50,
    snippet_length: int = 100,
    regex: bool = False,
) -> List[SearchResult]:
    """Search sessions using FTS5 full-text search or regex.

    Args:
        query: The search query
        directory: Optional directory filter (partial match)
        limit: Maximum number of sessions to return
        snippet_length: Approximate length of text snippets
        regex: If True, use regex matching instead of FTS5

    Returns:
        List of SearchResult objects with matching sessions and snippets
    """
    if not SEARCH_DB_PATH.exists():
        return []

    safe_query = query.strip()
    if not safe_query:
        return []

    results_map: dict[str, SearchResult] = {}

    with get_search_session() as db:
        if regex:
            # Regex search: query part_index directly using REGEXP
            try:
                pattern = re.compile(safe_query, re.IGNORECASE)
            except re.error as e:
                print(f"Invalid regex pattern: {e}", file=sys.stderr)
                return []

            sql = """
                SELECT
                    p.id as part_id,
                    p.session_id,
                    p.message_id,
                    p.role,
                    p.content,
                    p.time_created,
                    s.title,
                    s.directory,
                    s.time_updated
                FROM part_index p
                JOIN session_index s ON p.session_id = s.id
                WHERE p.content REGEXP :query
                  AND (s.archived = 0 OR s.archived IS NULL)
            """

            params: dict = {"query": safe_query}

            if directory:
                sql += " AND s.directory LIKE :directory"
                params["directory"] = f"%{directory}%"

            sql += " ORDER BY s.time_updated DESC LIMIT :limit"
            params["limit"] = limit * 10

            try:
                rows = db.execute(text(sql), params).fetchall()
            except Exception as e:
                print(f"Regex search error: {e}", file=sys.stderr)
                return []

            # Group matches by session with manually generated snippets
            for row in rows:
                session_id = row.session_id

                if session_id not in results_map:
                    results_map[session_id] = SearchResult(
                        session_id=session_id,
                        title=row.title,
                        directory=row.directory,
                        time_updated=row.time_updated,
                        matches=[],
                        total_matches=0,
                    )

                result = results_map[session_id]
                result.total_matches += 1

                if len(result.matches) < 3:
                    snippet = _generate_snippet(row.content, pattern, snippet_length)
                    result.matches.append(
                        SearchMatch(
                            part_id=row.part_id,
                            message_id=row.message_id,
                            role=row.role,
                            snippet=snippet,
                            time_created=row.time_created,
                        )
                    )
        else:
            # FTS5 search: escape query for literal/plaintext matching
            fts_query = _escape_fts5_query(safe_query)

            sql = """
                SELECT
                    p.id as part_id,
                    p.session_id,
                    p.message_id,
                    p.role,
                    p.content,
                    p.time_created,
                    s.title,
                    s.directory,
                    s.time_updated,
                    snippet(part_fts, 0, '<<MATCH>>', '<<END>>', '...', :snippet_tokens) as snippet
                FROM part_fts f
                JOIN part_index p ON f.rowid = p.rowid
                JOIN session_index s ON p.session_id = s.id
                WHERE part_fts MATCH :query
                  AND (s.archived = 0 OR s.archived IS NULL)
            """

            params = {
                "query": fts_query,
                "snippet_tokens": snippet_length // 5,
            }

            if directory:
                sql += " AND s.directory LIKE :directory"
                params["directory"] = f"%{directory}%"

            sql += " ORDER BY s.time_updated DESC LIMIT :limit"
            params["limit"] = limit * 10

            try:
                rows = db.execute(text(sql), params).fetchall()
            except Exception as e:
                print(f"Search query error: {e}", file=sys.stderr)
                return []

            # Group matches by session
            for row in rows:
                session_id = row.session_id

                if session_id not in results_map:
                    results_map[session_id] = SearchResult(
                        session_id=session_id,
                        title=row.title,
                        directory=row.directory,
                        time_updated=row.time_updated,
                        matches=[],
                        total_matches=0,
                    )

                result = results_map[session_id]
                result.total_matches += 1

                if len(result.matches) < 3:
                    result.matches.append(
                        SearchMatch(
                            part_id=row.part_id,
                            message_id=row.message_id,
                            role=row.role,
                            snippet=row.snippet or row.content[:snippet_length],
                            time_created=row.time_created,
                        )
                    )

        # Convert to list and limit
        results = list(results_map.values())[:limit]

    return results


def list_directories() -> List[str]:
    """Get a list of unique directories from indexed sessions (excluding archived)."""
    if not SEARCH_DB_PATH.exists():
        return []

    with get_search_session() as db:
        sql = """
            SELECT DISTINCT directory
            FROM session_index
            WHERE directory IS NOT NULL AND directory != ''
              AND (archived = 0 OR archived IS NULL)
            ORDER BY directory
        """
        rows = db.execute(text(sql)).fetchall()
        return [row[0] for row in rows]
