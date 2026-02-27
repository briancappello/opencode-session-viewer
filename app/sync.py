"""
Sync service for copying data from OpenCode source DB to the search index.

Performs incremental sync based on session time_updated timestamps.
Only user and assistant text content is indexed for search.
"""

import sys
import time

from pathlib import Path
from typing import Optional

from sqlalchemy import delete, select

from app.db import MessageModel, PartModel, SessionModel, get_db_session
from app.search_db import (
    PartIndex,
    SessionIndex,
    SyncMetadata,
    get_search_session,
    init_search_db,
)


def get_source_db_path() -> Path:
    """Get the OpenCode source database path."""
    return Path.home() / ".local/share/opencode/opencode.db"


def get_last_sync_time(search_db) -> Optional[int]:
    """Get the last sync timestamp from metadata."""
    result = search_db.execute(
        select(SyncMetadata).where(SyncMetadata.key == "last_sync_time")
    ).scalar_one_or_none()
    if result:
        return int(result.value)
    return None


def set_last_sync_time(search_db, timestamp: int):
    """Update the last sync timestamp."""
    existing = search_db.execute(
        select(SyncMetadata).where(SyncMetadata.key == "last_sync_time")
    ).scalar_one_or_none()

    if existing:
        existing.value = str(timestamp)
    else:
        search_db.add(SyncMetadata(key="last_sync_time", value=str(timestamp)))


def extract_text_from_part(part: PartModel) -> Optional[str]:
    """Extract searchable text content from a part.

    Only extracts text from 'text' type parts (user/assistant messages).
    Skips tool calls, tool results, and other part types.
    """
    if part.type != "text":
        return None

    return part.text


def sync_session(source_db, search_db, session: SessionModel):
    """Sync a single session and its parts to the search index."""
    # Upsert session index
    existing_session = search_db.get(SessionIndex, session.id)
    if existing_session:
        existing_session.directory = session.directory
        existing_session.title = session.title
        existing_session.time_updated = session.time_updated
    else:
        search_db.add(
            SessionIndex(
                id=session.id,
                directory=session.directory,
                title=session.title,
                time_updated=session.time_updated,
            )
        )

    # Delete existing parts for this session (will be re-indexed)
    search_db.execute(delete(PartIndex).where(PartIndex.session_id == session.id))

    # Get all messages and parts for this session
    messages = source_db.scalars(
        select(MessageModel).where(MessageModel.session_id == session.id)
    ).all()

    parts_indexed = 0
    for message in messages:
        role = message.role
        if role not in ("user", "assistant"):
            continue

        # Get parts for this message
        parts = source_db.scalars(
            select(PartModel).where(PartModel.message_id == message.id)
        ).all()

        for part in parts:
            text_content = extract_text_from_part(part)
            if not text_content or not text_content.strip():
                continue

            search_db.add(
                PartIndex(
                    id=part.id,
                    session_id=session.id,
                    message_id=message.id,
                    role=role,
                    content=text_content,
                    time_created=part.time_created,
                )
            )
            parts_indexed += 1

    return parts_indexed


def sync_search_index(force_full: bool = False):
    """Sync the search index from the source database.

    Args:
        force_full: If True, perform a full rebuild instead of incremental sync.
    """
    source_path = get_source_db_path()
    if not source_path.exists():
        print("Source database not found, skipping sync", file=sys.stderr)
        return

    # Initialize search database (creates tables if needed)
    init_search_db()

    start_time = time.time()
    sessions_synced = 0
    parts_indexed = 0

    with get_db_session(source_path) as source_db:
        with get_search_session() as search_db:
            last_sync = None if force_full else get_last_sync_time(search_db)

            # Get sessions to sync
            if last_sync:
                # Incremental: only sessions updated since last sync
                stmt = select(SessionModel).where(SessionModel.time_updated > last_sync)
            else:
                # Full sync: all sessions
                stmt = select(SessionModel)

            sessions = source_db.scalars(stmt).all()

            if not sessions:
                elapsed = time.time() - start_time
                print(
                    f"Search index up to date (checked in {elapsed:.2f}s)",
                    file=sys.stderr,
                )
                return

            # Sync each session
            for session in sessions:
                parts_count = sync_session(source_db, search_db, session)
                sessions_synced += 1
                parts_indexed += parts_count

            # Update sync timestamp to current time (in milliseconds)
            current_time_ms = int(time.time() * 1000)
            set_last_sync_time(search_db, current_time_ms)

            search_db.commit()

    elapsed = time.time() - start_time
    print(
        f"Search index synced: {sessions_synced} sessions, "
        f"{parts_indexed} parts indexed in {elapsed:.2f}s",
        file=sys.stderr,
    )


def rebuild_search_index():
    """Completely rebuild the search index from scratch."""
    from app.search_db import SEARCH_DB_PATH

    # Delete existing database
    if SEARCH_DB_PATH.exists():
        SEARCH_DB_PATH.unlink()

    # Perform full sync
    sync_search_index(force_full=True)
