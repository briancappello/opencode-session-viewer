import json

from typing import List, Optional

from sqlalchemy import ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

from app.config import Config


_engine = create_engine(f"sqlite:///{Config.OPENCODE_DB_PATH}?mode=ro")


def get_upstream_session() -> Session:
    """Create a new read-only SQLAlchemy session for the upstream database."""
    return Session(_engine)


class UpstreamBase(DeclarativeBase):
    pass


class UpstreamSession(UpstreamBase):
    __tablename__ = "session"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[Optional[str]] = mapped_column(String)
    parent_id: Mapped[Optional[str]] = mapped_column(String)
    slug: Mapped[Optional[str]] = mapped_column(String)
    directory: Mapped[Optional[str]] = mapped_column(String)
    title: Mapped[Optional[str]] = mapped_column(String)
    version: Mapped[Optional[str]] = mapped_column(String)

    # Summaries
    summary_additions: Mapped[Optional[int]] = mapped_column(Integer)
    summary_deletions: Mapped[Optional[int]] = mapped_column(Integer)
    summary_files: Mapped[Optional[int]] = mapped_column(Integer)

    # Times (milliseconds timestamp)
    time_created: Mapped[Optional[int]] = mapped_column(Integer)
    time_updated: Mapped[Optional[int]] = mapped_column(Integer)

    # Relationships
    messages: Mapped[List["UpstreamMessage"]] = relationship(
        "UpstreamMessage",
        back_populates="session",
        order_by="UpstreamMessage.time_created",
    )


class UpstreamMessage(UpstreamBase):
    __tablename__ = "message"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    data: Mapped[str] = mapped_column(Text)  # Stores JSON string
    time_created: Mapped[Optional[int]] = mapped_column(Integer)

    session_id: Mapped[str] = mapped_column(ForeignKey("session.id"))
    session: Mapped["UpstreamSession"] = relationship(
        "UpstreamSession", back_populates="messages"
    )

    parts: Mapped[List["UpstreamPart"]] = relationship(
        "UpstreamPart", back_populates="message", order_by="UpstreamPart.time_created"
    )

    @property
    def _json_data(self) -> dict:
        try:
            return json.loads(self.data)
        except (ValueError, TypeError):
            return {}

    @property
    def role(self) -> str:
        return self._json_data.get("role", "unknown")

    @property
    def agent(self) -> Optional[str]:
        return self._json_data.get("agent")

    @property
    def model(self) -> Optional[dict]:
        return self._json_data.get("model")

    @property
    def modelID(self) -> Optional[str]:
        return self._json_data.get("modelID")

    @property
    def summary(self) -> Optional[dict]:
        summary_value = self._json_data.get("summary")
        # Handle legacy boolean summary values (e.g., summary: true)
        # Convert to None so Pydantic validation succeeds
        if isinstance(summary_value, bool):
            return None
        return summary_value


class UpstreamPart(UpstreamBase):
    __tablename__ = "part"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    data: Mapped[str] = mapped_column(Text)  # Stores JSON string
    time_created: Mapped[Optional[int]] = mapped_column(Integer)

    message_id: Mapped[str] = mapped_column(ForeignKey("message.id"))
    message: Mapped["UpstreamMessage"] = relationship(
        "UpstreamMessage", back_populates="parts"
    )

    @property
    def _json_data(self) -> dict:
        try:
            return json.loads(self.data)
        except (ValueError, TypeError):
            return {}

    @property
    def type(self) -> str:
        return self._json_data.get("type", "unknown")

    @property
    def text(self) -> Optional[str]:
        return self._json_data.get("text")

    @property
    def tool(self) -> Optional[str]:
        return self._json_data.get("tool")

    @property
    def callID(self) -> Optional[str]:
        return self._json_data.get("callID")

    @property
    def state(self) -> Optional[dict]:
        return self._json_data.get("state")

    @property
    def tokens(self) -> Optional[dict]:
        return self._json_data.get("tokens")

    @property
    def synthetic(self) -> Optional[bool]:
        return self._json_data.get("synthetic")
