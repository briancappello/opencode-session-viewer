"""
Extensions database for user-defined customizations.

Intentionally separate from search_index.db so that a full search index
rebuild (which deletes that file) never touches user data.

This is the "parent" database: it owns all user-intent state including
archived status (so a search index rebuild never loses that data).
"""

from typing import Optional

from sqlalchemy import Boolean, String, UniqueConstraint, create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from app.config import Config


def get_db_session() -> Session:
    """Create a new SQLAlchemy session for the database."""
    return Session(get_db_engine())


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    """A conversation, keyed by the upstream session ID.

    Every upstream session gets a corresponding row here during sync, making
    this table the canonical root for all conversation queries.  User-controlled
    extension fields (title, slug) and archived state layer on top; sync only
    ever inserts new rows and never touches those fields on existing ones.
    """

    __tablename__ = "conversation"
    __table_args__ = (UniqueConstraint("slug", name="uq_conversation_slug"),)

    # Primary key — mirrors the upstream session.id.
    upstream_session_id: Mapped[str] = mapped_column(String, primary_key=True)

    # Nullable extension fields — None means "fall back to upstream value"
    title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    slug: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)

    # Archived state lives here (not in the ephemeral search index) so that a
    # full index rebuild never loses user-intent data.
    archived: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


def get_db_engine():
    """Create engine for the database."""
    engine = create_engine(f"sqlite:///{Config.MAIN_DB_PATH}")

    @event.listens_for(engine, "connect")
    def set_pragma(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def init_db():
    """Create tables if they don't exist, and run any pending migrations."""
    Config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    engine = get_db_engine()
    Base.metadata.create_all(engine)


# ---------------------------------------------------------------------------
# Conversation CRUD helpers
# ---------------------------------------------------------------------------


def get_conversation(upstream_session_id: str) -> Optional[Conversation]:
    """Return the Conversation row for the given upstream session ID, or None."""
    with get_db_session() as db:
        return db.get(Conversation, upstream_session_id)


def ensure_conversation_exists(upstream_session_id: str) -> None:
    """Guarantee a Conversation row exists for the given upstream session ID.

    Safe to call on every sync — if the row already exists, nothing is changed
    (user-controlled fields like title, slug, and archived are never touched).
    """
    with get_db_session() as db:
        if db.get(Conversation, upstream_session_id) is None:
            db.add(Conversation(upstream_session_id=upstream_session_id))
            db.commit()


def upsert_conversation(
    upstream_session_id: str,
    title: Optional[str] = ...,  # type: ignore[assignment]
    slug: Optional[str] = ...,  # type: ignore[assignment]
) -> Conversation:
    """Upsert extension fields for a conversation.

    Pass a value to update that field; omit (or pass Ellipsis) to leave it
    unchanged.  Passing ``None`` explicitly clears the extension for that field,
    reverting it to the upstream value.

    Returns the updated (or newly created) Conversation row.
    """
    with get_db_session() as db:
        row = db.get(Conversation, upstream_session_id)
        if row is None:
            row = Conversation(upstream_session_id=upstream_session_id)
            db.add(row)

        if title is not ...:
            row.title = title
        if slug is not ...:
            row.slug = slug

        db.commit()
        db.refresh(row)
        return row


def delete_conversation(upstream_session_id: str) -> bool:
    """Remove all extensions for a conversation.

    Returns True if a row was deleted, False if none existed.
    """
    with get_db_session() as db:
        row = db.get(Conversation, upstream_session_id)
        if row is None:
            return False
        db.delete(row)
        db.commit()
        return True


def get_conversation_by_slug(slug: str) -> Optional[Conversation]:
    """Resolve a slug to its Conversation row, or None if not found."""
    from sqlalchemy import select

    with get_db_session() as db:
        return db.execute(
            select(Conversation).where(Conversation.slug == slug)
        ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# Archived state helpers
# ---------------------------------------------------------------------------


def set_conversation_archived(upstream_session_id: str, archived: bool) -> bool:
    """Set the archived status of a conversation.

    Creates the Conversation row if it doesn't already exist.
    Returns True always (operation always succeeds).
    """
    with get_db_session() as db:
        row = db.get(Conversation, upstream_session_id)
        if row is None:
            row = Conversation(upstream_session_id=upstream_session_id, archived=archived)
            db.add(row)
        else:
            row.archived = archived
        db.commit()
        return True


def is_conversation_archived(upstream_session_id: str) -> bool:
    """Check if a conversation is archived."""
    with get_db_session() as db:
        row = db.get(Conversation, upstream_session_id)
        return row.archived if row else False


def get_archived_conversation_ids() -> set[str]:
    """Get all archived conversation IDs (as upstream session IDs)."""
    from sqlalchemy import select

    with get_db_session() as db:
        result = db.execute(
            select(Conversation.upstream_session_id).where(Conversation.archived == True)  # noqa: E712
        )
        return {row[0] for row in result.fetchall()}
