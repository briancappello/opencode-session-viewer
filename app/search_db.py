"""
Mirror database for FTS5 full-text search.

This module manages a local SQLite database with FTS5 indexing for fast
full-text search of session contents. The mirror database is synced from
the OpenCode source database on application startup.
"""

from pathlib import Path
from typing import Optional

from sqlalchemy import Integer, String, Text, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


# Mirror database location (in project directory)
SEARCH_DB_PATH = Path(__file__).resolve().parent.parent / "search_index.db"


class SearchBase(DeclarativeBase):
    pass


class SessionIndex(SearchBase):
    """Lightweight copy of session metadata for filtering."""

    __tablename__ = "session_index"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    directory: Mapped[Optional[str]] = mapped_column(String)
    title: Mapped[Optional[str]] = mapped_column(String)
    time_updated: Mapped[Optional[int]] = mapped_column(Integer)


class PartIndex(SearchBase):
    """Index of parts with extracted text for FTS."""

    __tablename__ = "part_index"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    session_id: Mapped[str] = mapped_column(String, index=True)
    message_id: Mapped[str] = mapped_column(String, index=True)
    role: Mapped[str] = mapped_column(String)  # user or assistant
    content: Mapped[str] = mapped_column(Text)  # extracted text content
    time_created: Mapped[Optional[int]] = mapped_column(Integer)


class SyncMetadata(SearchBase):
    """Tracks sync state."""

    __tablename__ = "sync_metadata"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(String)


def get_search_engine():
    """Create engine for the search index database."""
    engine = create_engine(f"sqlite:///{SEARCH_DB_PATH}")

    # Enable FTS5 support
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def get_search_session() -> Session:
    """Create a new SQLAlchemy session for the search database."""
    engine = get_search_engine()
    return Session(engine)


def init_search_db():
    """Initialize the search database with tables and FTS5 virtual table."""
    engine = get_search_engine()

    # Create regular tables
    SearchBase.metadata.create_all(engine)

    # Create FTS5 virtual table for full-text search
    with engine.connect() as conn:
        # Check if FTS table exists
        result = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type='table' AND name='part_fts'")
        )
        if not result.fetchone():
            # Create FTS5 virtual table
            # content='' means it's a contentless table (we store content in part_index)
            # We use external content to avoid data duplication
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
