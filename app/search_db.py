"""
Mirror database for FTS5 full-text search.

This module manages a local SQLite database with FTS5 indexing for fast
full-text search of session contents. The mirror database is synced from
the OpenCode source database on application startup.
"""

from pathlib import Path
from typing import Optional

from sqlalchemy import Boolean, Integer, String, Text, create_engine, event, text
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
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


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

    # Run migrations for existing databases
    with engine.connect() as conn:
        # Add archived column if it doesn't exist (migration for existing DBs)
        result = conn.execute(text("PRAGMA table_info(session_index)"))
        columns = [row[1] for row in result.fetchall()]
        if "archived" not in columns:
            conn.execute(
                text("ALTER TABLE session_index ADD COLUMN archived BOOLEAN DEFAULT 0")
            )
            conn.commit()

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


def set_session_archived(session_id: str, archived: bool) -> bool:
    """Set the archived status of a session.

    Returns True if the session was found and updated, False otherwise.
    """
    with get_search_session() as db:
        session = db.get(SessionIndex, session_id)
        if session:
            session.archived = archived
            db.commit()
            return True
        return False


def is_session_archived(session_id: str) -> bool:
    """Check if a session is archived."""
    with get_search_session() as db:
        session = db.get(SessionIndex, session_id)
        return session.archived if session else False


def get_archived_session_ids() -> set[str]:
    """Get all archived session IDs."""
    with get_search_session() as db:
        result = db.execute(text("SELECT id FROM session_index WHERE archived = 1"))
        return {row[0] for row in result.fetchall()}
