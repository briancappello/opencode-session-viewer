"""
Overrides database for user-defined customisations.

Intentionally separate from search_index.db so that a full search index
rebuild (which deletes that file) never touches user data.
"""

from pathlib import Path
from typing import Optional

from sqlalchemy import String, UniqueConstraint, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column


# Overrides database location (in project directory, alongside search_index.db)
OVERRIDES_DB_PATH = Path(__file__).resolve().parent.parent / "overrides.db"


class OverridesBase(DeclarativeBase):
    pass


class SessionOverride(OverridesBase):
    """Optional user-defined overrides for a mirrored session.

    A row only exists when at least one field has been customised.
    Absence of a row means "use upstream values for everything".
    """

    __tablename__ = "session_override"
    __table_args__ = (UniqueConstraint("human_id", name="uq_session_override_human_id"),)

    # Logical FK to session_index.id — not enforced at the DB level because
    # session_index lives in a separate file (search_index.db).
    session_id: Mapped[str] = mapped_column(String, primary_key=True)

    # Nullable overrides — None means "fall back to upstream value"
    title: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    human_id: Mapped[Optional[str]] = mapped_column(String, nullable=True, index=True)


def get_overrides_engine():
    """Create engine for the overrides database."""
    engine = create_engine(f"sqlite:///{OVERRIDES_DB_PATH}")

    @event.listens_for(engine, "connect")
    def set_pragma(dbapi_connection, _connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def get_overrides_session() -> Session:
    """Create a new SQLAlchemy session for the overrides database."""
    return Session(get_overrides_engine())


def init_overrides_db():
    """Create tables if they don't exist. Safe to call on every startup."""
    engine = get_overrides_engine()
    OverridesBase.metadata.create_all(engine)


# ---------------------------------------------------------------------------
# CRUD helpers
# ---------------------------------------------------------------------------


def get_session_override(session_id: str) -> Optional[SessionOverride]:
    """Return the override row for a session, or None if none exists."""
    with get_overrides_session() as db:
        return db.get(SessionOverride, session_id)


def set_session_override(
    session_id: str,
    title: Optional[str] = ...,      # type: ignore[assignment]
    human_id: Optional[str] = ...,   # type: ignore[assignment]
) -> SessionOverride:
    """Upsert override fields for a session.

    Pass a value to update that field; omit (or pass Ellipsis) to leave it
    unchanged.  Passing ``None`` explicitly clears the override for that field,
    reverting it to the upstream value.

    Returns the updated (or newly created) SessionOverride row.
    """
    with get_overrides_session() as db:
        row = db.get(SessionOverride, session_id)
        if row is None:
            row = SessionOverride(session_id=session_id)
            db.add(row)

        if title is not ...:
            row.title = title
        if human_id is not ...:
            row.human_id = human_id

        db.commit()
        db.refresh(row)
        return row


def delete_session_override(session_id: str) -> bool:
    """Remove all overrides for a session.

    Returns True if a row was deleted, False if none existed.
    """
    with get_overrides_session() as db:
        row = db.get(SessionOverride, session_id)
        if row is None:
            return False
        db.delete(row)
        db.commit()
        return True


def get_session_id_by_human_id(human_id: str) -> Optional[str]:
    """Resolve a human_id to its canonical session_id, or None if not found."""
    from sqlalchemy import select

    with get_overrides_session() as db:
        row = db.execute(
            select(SessionOverride).where(SessionOverride.human_id == human_id)
        ).scalar_one_or_none()
        return row.session_id if row else None
