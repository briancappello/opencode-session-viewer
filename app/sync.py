"""
Sync service for copying data from the upstream OpenCode DB to the search index.

Performs incremental sync based on conversation (upstream: session) time_updated
timestamps. Only user and assistant text content is indexed for search.

Archived state is NOT managed here — it lives in db.py (.db) so that a full
index rebuild never loses user intent.
"""

import sys
import time

from typing import Optional

from sqlalchemy import delete, select

from app.config import Config
from app.db import ensure_conversation_exists
from app.db_search import (
    SearchConversationIndex,
    SearchPartIndex,
    SearchSyncMetadata,
    get_search_session,
    init_search_db,
)
from app.db_upstream import (
    UpstreamMessage,
    UpstreamPart,
    UpstreamSession,
    get_upstream_session,
)


def get_last_sync_time(search_db) -> Optional[int]:
    """Get the last sync timestamp from metadata."""
    result = search_db.execute(
        select(SearchSyncMetadata).where(SearchSyncMetadata.key == "last_sync_time")
    ).scalar_one_or_none()
    if result:
        return int(result.value)
    return None


def set_last_sync_time(search_db, timestamp: int):
    """Update the last sync timestamp."""
    existing = search_db.execute(
        select(SearchSyncMetadata).where(SearchSyncMetadata.key == "last_sync_time")
    ).scalar_one_or_none()

    if existing:
        existing.value = str(timestamp)
    else:
        search_db.add(SearchSyncMetadata(key="last_sync_time", value=str(timestamp)))


def extract_text_from_part(part: UpstreamPart) -> Optional[str]:
    """Extract searchable text content from a part.

    Only extracts text from 'text' type parts (user/assistant messages).
    Skips tool calls, tool results, and other part types.
    """
    if part.type != "text":
        return None
    return part.text


def sync_conversation(source_db, search_db, upstream_conv: UpstreamSession):
    """Sync a single upstream conversation and its parts to the search index.

    Args:
        source_db: SQLAlchemy session for the upstream (read-only) database
        search_db: SQLAlchemy session for the search index database
        upstream_conv: The upstream UpstreamSession record to sync
    """
    # Ensure a Conversation row exists in db.py (the canonical root).
    # This is an insert-or-ignore — user fields (title, slug, archived) are never touched.
    ensure_conversation_exists(upstream_conv.id)

    # Upsert conversation into the search index (archived state lives in db.py, not here)
    existing = search_db.get(SearchConversationIndex, upstream_conv.id)
    if existing:
        existing.directory = upstream_conv.directory
        existing.title = upstream_conv.title
        existing.time_updated = upstream_conv.time_updated
    else:
        search_db.add(
            SearchConversationIndex(
                id=upstream_conv.id,
                directory=upstream_conv.directory,
                title=upstream_conv.title,
                time_updated=upstream_conv.time_updated,
            )
        )

    # Delete existing parts for this conversation (will be re-indexed)
    search_db.execute(
        delete(SearchPartIndex).where(
            SearchPartIndex.upstream_session_id == upstream_conv.id
        )
    )

    # Get all messages and parts for this conversation
    messages = source_db.scalars(
        select(UpstreamMessage).where(UpstreamMessage.session_id == upstream_conv.id)
    ).all()

    parts_indexed = 0
    for message in messages:
        role = message.role
        if role not in ("user", "assistant"):
            continue

        parts = source_db.scalars(
            select(UpstreamPart).where(UpstreamPart.message_id == message.id)
        ).all()

        for part in parts:
            text_content = extract_text_from_part(part)
            if not text_content or not text_content.strip():
                continue

            search_db.add(
                SearchPartIndex(
                    id=part.id,
                    upstream_session_id=upstream_conv.id,
                    message_id=message.id,
                    role=role,
                    content=text_content,
                    time_created=part.time_created,
                )
            )
            parts_indexed += 1

    return parts_indexed


def sync_search_index(force_full: bool = False):
    """Sync the search index from the upstream source database.

    Args:
        force_full: If True, perform a full rebuild instead of incremental sync.
    """
    if not Config.OPENCODE_DB_PATH.exists():
        print("Upstream database not found, skipping sync", file=sys.stderr)
        return

    # Initialize search database (creates tables if needed)
    init_search_db()

    start_time = time.time()
    conversations_synced = 0
    parts_indexed = 0

    with get_upstream_session() as source_db:
        with get_search_session() as search_db:
            last_sync = None if force_full else get_last_sync_time(search_db)

            if last_sync:
                # Incremental: only conversations updated since last sync
                stmt = select(UpstreamSession).where(
                    UpstreamSession.time_updated > last_sync
                )
            else:
                # Full sync: all conversations
                stmt = select(UpstreamSession)

            upstream_conversations = source_db.scalars(stmt).all()

            if not upstream_conversations:
                elapsed = time.time() - start_time
                print(
                    f"Search index up to date (checked in {elapsed:.2f}s)",
                    file=sys.stderr,
                )
                return

            for upstream_conv in upstream_conversations:
                parts_count = sync_conversation(source_db, search_db, upstream_conv)
                conversations_synced += 1
                parts_indexed += parts_count

            # Update sync timestamp to current time (in milliseconds)
            current_time_ms = int(time.time() * 1000)
            set_last_sync_time(search_db, current_time_ms)

            search_db.commit()

    elapsed = time.time() - start_time
    print(
        f"Search index synced: {conversations_synced} conversations, "
        f"{parts_indexed} parts indexed in {elapsed:.2f}s",
        file=sys.stderr,
    )


def rebuild_search_index():
    """Completely rebuild the search index from scratch.

    Archived state is preserved automatically because it lives in db.py, not here.
    """

    if Config.SEARCH_DB_PATH.exists():
        Config.SEARCH_DB_PATH.unlink()

    sync_search_index(force_full=True)
