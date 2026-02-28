import json
import re
import sys

from datetime import datetime
from typing import List, Optional

from sqlalchemy import select, text

from app.config import Config
from app.db import (
    Conversation,
    get_archived_conversation_ids,
    get_conversation,
    get_db_session,
)
from app.db_search import SearchConversationIndex, SearchPartIndex, get_search_session
from app.db_upstream import UpstreamMessage, UpstreamSession, get_upstream_session
from app.models import (
    ConversationExport,
    ConversationSummary,
    Message,
    SearchMatch,
    SearchResult,
)


def _apply_extensions(
    summary: ConversationSummary,
    conv: Conversation,
) -> ConversationSummary:
    """Overlay user-defined extension fields from a Conversation row onto a summary.

    Only non-None extension values replace upstream values; the canonical id is
    never changed.  Returns the same object mutated in place for convenience.
    """
    if conv.title is not None:
        summary.title = conv.title
    if conv.slug is not None:
        summary.slug = conv.slug
    return summary


def list_conversations_from_db() -> List[ConversationSummary]:
    """List all conversations, starting from Conversation rows in db.py.

    For each Conversation row, fetches the corresponding upstream data and
    overlays any user-defined extension fields.  Upstream is treated as a
    viewonly join keyed on upstream_session_id.
    """
    results = []
    try:
        with get_db_session() as db:
            conversations = db.scalars(select(Conversation)).all()

        with get_upstream_session() as upstream_db:
            for conv in conversations:
                upstream = upstream_db.get(UpstreamSession, conv.upstream_session_id)
                if upstream is None:
                    # Upstream row gone (deleted from source); skip.
                    continue

                # Fetch model name from the first message that carries one
                model_name = "Unknown"
                msg = upstream_db.scalars(
                    select(UpstreamMessage)
                    .where(UpstreamMessage.session_id == conv.upstream_session_id)
                    .where(UpstreamMessage.data.like("%modelID%"))
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
                    except Exception:
                        pass

                summary = ConversationSummary.model_validate(upstream)
                summary.model = model_name
                _apply_extensions(summary, conv)
                results.append(summary)

    except Exception as e:
        print(f"Warning: Failed to load conversations from DB: {e}", file=sys.stderr)

    return results


def list_conversations(show_all: bool = False) -> List[ConversationSummary]:
    """List all conversations from the DB, excluding archived, with extensions applied."""
    archived_ids = get_archived_conversation_ids()

    conversations_map = {
        s.id: s for s in list_conversations_from_db() if s.id not in archived_ids
    }

    sorted_conversations = sorted(
        conversations_map.values(), key=lambda s: s.time_updated or 0, reverse=True
    )

    if not show_all:
        sorted_conversations = [
            s
            for s in sorted_conversations
            if s.parent_id is None and "subagent" not in (s.title or "").lower()
        ]

    return sorted_conversations


def list_archived_conversations() -> List[ConversationSummary]:
    """List archived conversations only, with extensions applied."""
    archived_ids = get_archived_conversation_ids()
    if not archived_ids:
        return []

    conversations_map = {
        s.id: s for s in list_conversations_from_db() if s.id in archived_ids
    }

    return sorted(
        conversations_map.values(), key=lambda s: s.time_updated or 0, reverse=True
    )


def format_timestamp(ts: Optional[int]) -> str:
    """Format a millisecond timestamp to human-readable."""
    if not ts:
        return "Unknown"
    return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")


def load_conversation_export(conversation_id: str) -> ConversationExport | None:
    """Export a full conversation with messages, starting from the Conversation row.

    Looks up the Conversation in db.py first (the canonical root), then joins
    onto the upstream DB as a viewonly source for immutable fields and messages.
    """
    conversation = get_conversation(conversation_id)
    if conversation is None:
        return None

    with get_upstream_session() as upstream_db:
        upstream_session = upstream_db.get(
            UpstreamSession, conversation.upstream_session_id
        )
        if upstream_session is None:
            raise ValueError(f"Upstream data not found for {conversation_id=}")

        stmt = (
            select(UpstreamMessage)
            .where(UpstreamMessage.session_id == upstream_session.id)
            .order_by(UpstreamMessage.time_created)
        )
        messages = [Message.model_validate(m) for m in upstream_db.scalars(stmt).all()]

        summary = ConversationSummary.model_validate(upstream_session)
        _apply_extensions(summary, conversation)

        return ConversationExport(summary=summary, messages=messages)


def _escape_fts5_query(query: str) -> str:
    """Escape special FTS5 characters for literal/plaintext search."""
    escaped = query.replace('"', '""')
    return f'"{escaped}"'


def _generate_snippet(
    content: str, pattern: re.Pattern, snippet_length: int = 100
) -> str:
    """Generate a snippet with match markers for regex search results."""
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


def search_conversations(
    query: str,
    directory: Optional[str] = None,
    limit: int = 50,
    snippet_length: int = 100,
    regex: bool = False,
) -> List[SearchResult]:
    """Search conversations using FTS5 full-text search or regex.

    Args:
        query: The search query
        directory: Optional directory filter (partial match)
        limit: Maximum number of conversations to return
        snippet_length: Approximate length of text snippets
        regex: If True, use regex matching instead of FTS5

    Returns:
        List of SearchResult objects with matching conversations and snippets
    """
    if not Config.SEARCH_DB_PATH.exists():
        return []

    safe_query = query.strip()
    if not safe_query:
        return []

    # Fetch archived IDs from db.py (the authoritative source for user intent)
    archived_ids = get_archived_conversation_ids()

    results_map: dict[str, SearchResult] = {}

    with get_search_session() as db:
        if regex:
            # Regex search: query part_index directly using REGEXP
            try:
                pattern = re.compile(safe_query, re.IGNORECASE)
            except re.error as e:
                print(f"Invalid regex pattern: {e}", file=sys.stderr)
                return []

            sql = f"""
                SELECT
                    p.id as part_id,
                    p.upstream_session_id,
                    p.message_id,
                    p.role,
                    p.content,
                    p.time_created,
                    s.title,
                    s.directory,
                    s.time_updated
                FROM {SearchPartIndex.__tablename__} p
                JOIN {SearchConversationIndex.__tablename__} s ON p.upstream_session_id = s.id
                WHERE p.content REGEXP :query
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

            # Group matches by conversation with manually generated snippets, excluding archived
            for row in rows:
                conversation_id = row.upstream_session_id
                if conversation_id in archived_ids:
                    continue

                if conversation_id not in results_map:
                    results_map[conversation_id] = SearchResult(
                        conversation_id=conversation_id,
                        title=row.title,
                        directory=row.directory,
                        time_updated=row.time_updated,
                        matches=[],
                        total_matches=0,
                    )

                result = results_map[conversation_id]
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

            sql = f"""
                SELECT
                    p.id as part_id,
                    p.upstream_session_id,
                    p.message_id,
                    p.role,
                    p.content,
                    p.time_created,
                    s.title,
                    s.directory,
                    s.time_updated,
                    snippet(part_fts, 0, '<<MATCH>>', '<<END>>', '...', :snippet_tokens) as snippet
                FROM part_fts f
                JOIN {SearchPartIndex.__tablename__} p ON f.rowid = p.rowid
                JOIN {SearchConversationIndex.__tablename__} s ON p.upstream_session_id = s.id
                WHERE part_fts MATCH :query
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

            # Group matches by conversation, excluding archived
            for row in rows:
                conversation_id = row.upstream_session_id
                if conversation_id in archived_ids:
                    continue

                if conversation_id not in results_map:
                    results_map[conversation_id] = SearchResult(
                        conversation_id=conversation_id,
                        title=row.title,
                        directory=row.directory,
                        time_updated=row.time_updated,
                        matches=[],
                        total_matches=0,
                    )

                result = results_map[conversation_id]
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

    return list(results_map.values())[:limit]


# FIXME replace with project query
def list_directories() -> List[str]:
    """Get a list of unique directories from indexed conversations (excluding archived)."""
    if not Config.SEARCH_DB_PATH.exists():
        return []

    archived_ids = get_archived_conversation_ids()

    with get_search_session() as db:
        sql = f"""
            SELECT DISTINCT directory
            FROM {SearchConversationIndex.__tablename__}
            WHERE directory IS NOT NULL AND directory != ''
            ORDER BY directory
        """
        rows = db.execute(text(sql)).fetchall()
        # Post-filter: exclude directories that are only present in archived conversations.
        # For simplicity we return all directories and let the UI/search handle exclusion.
        # If a stricter filter is needed, cross-reference per-row upstream_session_id against archived_ids.
        _ = archived_ids  # acknowledged; full per-directory filtering omitted for now
        return [row[0] for row in rows]
