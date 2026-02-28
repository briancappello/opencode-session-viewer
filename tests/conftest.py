"""
Shared pytest fixtures for the opencode-session-viewer test suite.

Strategy
--------
All three databases (main/extensions, search/FTS5, upstream) are replaced
with fresh temporary SQLite files for every test that needs them.

Each app DB module now holds a module-level ``_engine``.  Fixtures here swap
that engine out for one pointing at a temp file, then restore the original on
teardown — no engine-per-call leaks, no ResourceWarnings.
"""

from __future__ import annotations

import json

from pathlib import Path
from typing import Generator

import pytest

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

import app.db as db_module
import app.db_search as db_search_module
import app.db_upstream as db_upstream_module

from app.db import Base, Conversation
from app.db_search import SearchBase, SearchConversationIndex, SearchPartIndex
from app.db_upstream import UpstreamBase, UpstreamMessage, UpstreamPart, UpstreamSession


# ---------------------------------------------------------------------------
# Engine factories (used by fixtures to build per-test engines)
# ---------------------------------------------------------------------------


def _make_main_engine(path: Path):
    engine = create_engine(f"sqlite:///{path}")

    @event.listens_for(engine, "connect")
    def set_pragma(dbapi_connection, _):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    return engine


def _make_search_engine(path: Path):
    from app.db_search import _sqlite_regexp

    engine = create_engine(f"sqlite:///{path}")

    @event.listens_for(engine, "connect")
    def set_pragma(dbapi_connection, _):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.close()
        dbapi_connection.create_function("REGEXP", 2, _sqlite_regexp)

    return engine


def _make_upstream_engine(path: Path):
    return create_engine(f"sqlite:///{path}")


def _init_fts5(engine):
    with engine.connect() as conn:
        conn.execute(
            text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS part_fts USING fts5(
                content,
                content='part_index',
                content_rowid='rowid',
                tokenize='porter unicode61'
            )
        """)
        )
        conn.execute(
            text("""
            CREATE TRIGGER IF NOT EXISTS part_index_ai
            AFTER INSERT ON part_index BEGIN
                INSERT INTO part_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
            END
        """)
        )
        conn.execute(
            text("""
            CREATE TRIGGER IF NOT EXISTS part_index_ad
            AFTER DELETE ON part_index BEGIN
                INSERT INTO part_fts(part_fts, rowid, content)
                VALUES ('delete', OLD.rowid, OLD.content);
            END
        """)
        )
        conn.execute(
            text("""
            CREATE TRIGGER IF NOT EXISTS part_index_au
            AFTER UPDATE ON part_index BEGIN
                INSERT INTO part_fts(part_fts, rowid, content)
                VALUES ('delete', OLD.rowid, OLD.content);
                INSERT INTO part_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
            END
        """)
        )
        conn.commit()


# ---------------------------------------------------------------------------
# Core fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def patched_config(tmp_path: Path, monkeypatch):
    """
    Swap each module's ``_engine`` for one pointing at a temp SQLite file.
    Restores the originals on teardown via monkeypatch.
    """
    main_engine = _make_main_engine(tmp_path / "main.db")
    search_engine = _make_search_engine(tmp_path / "search_index.db")
    upstream_engine = _make_upstream_engine(tmp_path / "opencode.db")

    monkeypatch.setattr(db_module, "_engine", main_engine)
    monkeypatch.setattr(db_search_module, "_engine", search_engine)
    monkeypatch.setattr(db_upstream_module, "_engine", upstream_engine)

    yield {
        "main_db_path": tmp_path / "main.db",
        "search_db_path": tmp_path / "search_index.db",
        "upstream_db_path": tmp_path / "opencode.db",
        "main_engine": main_engine,
        "search_engine": search_engine,
        "upstream_engine": upstream_engine,
    }

    main_engine.dispose()
    search_engine.dispose()
    upstream_engine.dispose()


@pytest.fixture()
def main_db(patched_config):
    """Initialised main (extensions) DB; yields an open Session."""
    engine = patched_config["main_engine"]
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture()
def search_db(patched_config):
    """Initialised search-index DB (including FTS5); yields an open Session."""
    engine = patched_config["search_engine"]
    SearchBase.metadata.create_all(engine)
    _init_fts5(engine)
    with Session(engine) as session:
        yield session


@pytest.fixture()
def upstream_db(patched_config):
    """Writable upstream DB; yields an open Session."""
    engine = patched_config["upstream_engine"]
    UpstreamBase.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


# ---------------------------------------------------------------------------
# Data factory helpers
# ---------------------------------------------------------------------------


def make_upstream_session(
    id: str = "sess-1",
    title: str = "Test Session",
    directory: str = "/home/user/project",
    time_created: int = 1_700_000_000_000,
    time_updated: int = 1_700_000_001_000,
    parent_id: str | None = None,
    project_id: str | None = "proj-1",
) -> UpstreamSession:
    return UpstreamSession(
        id=id,
        title=title,
        directory=directory,
        time_created=time_created,
        time_updated=time_updated,
        parent_id=parent_id,
        project_id=project_id,
        summary_additions=0,
        summary_deletions=0,
        summary_files=0,
    )


def make_upstream_message(
    id: str = "msg-1",
    session_id: str = "sess-1",
    role: str = "user",
    time_created: int = 1_700_000_000_500,
    model_id: str | None = None,
) -> UpstreamMessage:
    data: dict = {"role": role}
    if model_id:
        data["model"] = {"modelID": model_id, "providerID": "anthropic"}
    return UpstreamMessage(
        id=id,
        session_id=session_id,
        data=json.dumps(data),
        time_created=time_created,
    )


def make_upstream_part(
    id: str = "part-1",
    message_id: str = "msg-1",
    part_type: str = "text",
    text: str | None = "Hello world",
    time_created: int = 1_700_000_000_600,
) -> UpstreamPart:
    data: dict = {"type": part_type}
    if text is not None:
        data["text"] = text
    return UpstreamPart(
        id=id,
        message_id=message_id,
        data=json.dumps(data),
        time_created=time_created,
    )


# ---------------------------------------------------------------------------
# Populated DB fixture
# ---------------------------------------------------------------------------


@pytest.fixture()
def populated_dbs(upstream_db, main_db, search_db):
    """
    All three databases initialised and populated with a minimal dataset:

    - upstream: 2 sessions, each with 1 message and 1 text part
    - main/extensions: corresponding Conversation rows (archived=False)
    - search: corresponding conversation_index + part_index rows
    """
    sess1 = make_upstream_session(id="sess-1", title="First Session", directory="/proj/a")
    sess2 = make_upstream_session(
        id="sess-2",
        title="Second Session",
        directory="/proj/b",
        time_updated=1_700_000_002_000,
    )
    msg1 = make_upstream_message(
        id="msg-1", session_id="sess-1", role="user", model_id="claude-3-5-sonnet"
    )
    msg2 = make_upstream_message(id="msg-2", session_id="sess-2", role="assistant")
    part1 = make_upstream_part(id="part-1", message_id="msg-1", text="Hello from user")
    part2 = make_upstream_part(
        id="part-2", message_id="msg-2", text="Hello from assistant"
    )
    upstream_db.add_all([sess1, sess2, msg1, msg2, part1, part2])
    upstream_db.commit()

    conv1 = Conversation(upstream_session_id="sess-1", archived=False)
    conv2 = Conversation(upstream_session_id="sess-2", archived=False)
    main_db.add_all([conv1, conv2])
    main_db.commit()

    ci1 = SearchConversationIndex(
        id="sess-1",
        title="First Session",
        directory="/proj/a",
        time_updated=1_700_000_001_000,
    )
    ci2 = SearchConversationIndex(
        id="sess-2",
        title="Second Session",
        directory="/proj/b",
        time_updated=1_700_000_002_000,
    )
    pi1 = SearchPartIndex(
        id="part-1",
        upstream_session_id="sess-1",
        message_id="msg-1",
        role="user",
        content="Hello from user",
        time_created=1_700_000_000_600,
    )
    pi2 = SearchPartIndex(
        id="part-2",
        upstream_session_id="sess-2",
        message_id="msg-2",
        role="assistant",
        content="Hello from assistant",
        time_created=1_700_000_000_600,
    )
    search_db.add_all([ci1, ci2, pi1, pi2])
    search_db.commit()

    return {
        "upstream_db": upstream_db,
        "main_db": main_db,
        "search_db": search_db,
    }
