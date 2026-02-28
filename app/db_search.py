"""
Mirror database for FTS5 full-text search.

This module manages a local SQLite database with FTS5 indexing for fast
full-text search of conversation contents. The mirror database is synced from
the OpenCode source database on application startup.

Archived state is NOT stored here — it lives in db.py (.db) so that a full
index rebuild never loses user intent data.
"""

import re

from typing import Optional

from sqlalchemy import Integer, String, Text, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from app.config import Config


def _make_engine():
    engine = create_engine(f"sqlite:///{Config.SEARCH_DB_PATH}")

    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()
        dbapi_connection.create_function("REGEXP", 2, _sqlite_regexp)

    return engine


_engine = _make_engine()


def get_search_session() -> Session:
    """Create a new SQLAlchemy session for the search database."""
    return Session(_engine)


class SearchBase(DeclarativeBase):
    pass


class SearchConversationIndex(SearchBase):
    """
    Lightweight copy of upstream conversation (opencode session) metadata for filtering.
    """

    __tablename__ = "conversation_index"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    directory: Mapped[Optional[str]] = mapped_column(String)
    title: Mapped[Optional[str]] = mapped_column(String)
    time_updated: Mapped[Optional[int]] = mapped_column(Integer)


class SearchPartIndex(SearchBase):
    """Index of parts with extracted text for FTS."""

    __tablename__ = "part_index"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    upstream_session_id: Mapped[str] = mapped_column(index=True)
    message_id: Mapped[str] = mapped_column(String, index=True)
    role: Mapped[str] = mapped_column(String)  # user or assistant
    content: Mapped[str] = mapped_column(Text)  # extracted text content
    time_created: Mapped[Optional[int]] = mapped_column(Integer)


class SearchSyncMetadata(SearchBase):
    """Tracks sync state."""

    __tablename__ = "sync_metadata"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


def _sqlite_regexp(pattern: str, string: str) -> bool:
    """SQLite REGEXP function implementation using Python's re module."""
    if string is None:
        return False
    try:
        return re.search(pattern, string, re.IGNORECASE) is not None
    except re.error:
        # Invalid regex pattern
        return False


def init_search_db():
    """Initialize the search database with tables and FTS5 virtual table."""
    engine = _engine

    # Create regular tables
    SearchBase.metadata.create_all(engine)

    # Create FTS5 virtual table for full-text search
    with engine.connect() as conn:
        result = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='part_fts'")
        )
        if not result.fetchone():
            conn.execute(
                text(
                    """
                    CREATE VIRTUAL TABLE part_fts USING fts5(
                        content,
                        content='part_index',
                        content_rowid='rowid',
                        tokenize='porter unicode61'
                    )
                    """
                )
            )

            # Create triggers to keep FTS in sync with part_index
            conn.execute(
                text(
                    """
                    CREATE TRIGGER part_index_ai AFTER INSERT ON part_index BEGIN
                        INSERT INTO part_fts(rowid, content)
                        VALUES (NEW.rowid, NEW.content);
                    END
                    """
                )
            )

            conn.execute(
                text(
                    """
                    CREATE TRIGGER part_index_ad AFTER DELETE ON part_index BEGIN
                        INSERT INTO part_fts(part_fts, rowid, content)
                        VALUES ('delete', OLD.rowid, OLD.content);
                    END
                    """
                )
            )

            conn.execute(
                text(
                    """
                    CREATE TRIGGER part_index_au AFTER UPDATE ON part_index BEGIN
                        INSERT INTO part_fts(part_fts, rowid, content)
                        VALUES ('delete', OLD.rowid, OLD.content);
                        INSERT INTO part_fts(rowid, content)
                        VALUES (NEW.rowid, NEW.content);
                    END
                    """
                )
            )

            conn.commit()
