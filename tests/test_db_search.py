"""
Tests for app/db_search.py — search-index database initialisation, FTS5,
and the REGEXP helper.
"""

from sqlalchemy import text

import app.db_search as db_search_module

from app.db_search import (
    SearchPartIndex,
    SearchSyncMetadata,
    _sqlite_regexp,
    init_search_db,
)


# ---------------------------------------------------------------------------
# _sqlite_regexp unit tests (pure Python — no DB required)
# ---------------------------------------------------------------------------


class TestSqliteRegexp:
    def test_matches_simple_pattern(self):
        assert _sqlite_regexp("hello", "say hello world") is True

    def test_no_match(self):
        assert _sqlite_regexp("xyz", "hello world") is False

    def test_case_insensitive(self):
        assert _sqlite_regexp("HELLO", "hello world") is True

    def test_returns_false_for_none_string(self):
        assert _sqlite_regexp("pattern", None) is False  # type: ignore[arg-type]

    def test_invalid_regex_returns_false(self):
        assert _sqlite_regexp("[invalid", "some text") is False

    def test_dot_star_matches_anything(self):
        assert _sqlite_regexp(".*", "anything") is True

    def test_anchored_pattern(self):
        assert _sqlite_regexp("^start", "start of string") is True
        assert _sqlite_regexp("^start", "not at start") is False


# ---------------------------------------------------------------------------
# init_search_db — schema creation
# ---------------------------------------------------------------------------


class TestInitSearchDb:
    def test_creates_tables_and_fts(self, patched_config):
        """init_search_db must create all tables including the FTS5 virtual table."""
        init_search_db()

        with db_search_module._engine.connect() as conn:
            # Verify regular tables exist
            for table in ("conversation_index", "part_index", "sync_metadata"):
                result = conn.execute(
                    text(
                        f"SELECT name FROM sqlite_master "
                        f"WHERE type='table' AND name='{table}'"
                    )
                ).fetchone()
                assert result is not None, f"Table '{table}' should exist"

            # Verify FTS5 virtual table
            result = conn.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table' AND name='part_fts'"
                )
            ).fetchone()
            assert result is not None, "FTS5 virtual table 'part_fts' should exist"

    def test_idempotent(self, patched_config):
        """Calling init_search_db twice must not raise."""
        init_search_db()
        init_search_db()  # Second call should be a no-op


# ---------------------------------------------------------------------------
# FTS5 triggers — INSERT/DELETE/UPDATE propagation
# ---------------------------------------------------------------------------


class TestFts5Triggers:
    def test_insert_populates_fts(self, search_db):
        row = SearchPartIndex(
            id="p1",
            upstream_session_id="s1",
            message_id="m1",
            role="user",
            content="pytest is great for testing",
            time_created=1000,
        )
        search_db.add(row)
        search_db.commit()

        result = search_db.execute(
            text("SELECT rowid FROM part_fts WHERE part_fts MATCH 'pytest'")
        ).fetchall()
        assert len(result) == 1

    def test_delete_removes_from_fts(self, search_db):
        row = SearchPartIndex(
            id="p-del",
            upstream_session_id="s1",
            message_id="m1",
            role="user",
            content="delete me from fts",
            time_created=1000,
        )
        search_db.add(row)
        search_db.commit()

        search_db.delete(row)
        search_db.commit()

        result = search_db.execute(
            text("SELECT rowid FROM part_fts WHERE part_fts MATCH 'delete'")
        ).fetchall()
        assert len(result) == 0

    def test_update_replaces_in_fts(self, search_db):
        row = SearchPartIndex(
            id="p-upd",
            upstream_session_id="s1",
            message_id="m1",
            role="user",
            content="original content alpha",
            time_created=1000,
        )
        search_db.add(row)
        search_db.commit()

        row.content = "updated content beta"
        search_db.commit()

        # Old term should be gone
        old = search_db.execute(
            text("SELECT rowid FROM part_fts WHERE part_fts MATCH 'alpha'")
        ).fetchall()
        assert len(old) == 0

        # New term should be present
        new = search_db.execute(
            text("SELECT rowid FROM part_fts WHERE part_fts MATCH 'beta'")
        ).fetchall()
        assert len(new) == 1


# ---------------------------------------------------------------------------
# REGEXP function via the engine
# ---------------------------------------------------------------------------


class TestRegexpFunction:
    def test_regexp_in_query(self, search_db):
        row = SearchPartIndex(
            id="p-re",
            upstream_session_id="s1",
            message_id="m1",
            role="user",
            content="The quick brown fox",
            time_created=1000,
        )
        search_db.add(row)
        search_db.commit()

        result = search_db.execute(
            text("SELECT id FROM part_index WHERE content REGEXP :pat"),
            {"pat": "quick.*fox"},
        ).fetchall()
        assert len(result) == 1
        assert result[0][0] == "p-re"

    def test_regexp_no_match(self, search_db):
        row = SearchPartIndex(
            id="p-re2",
            upstream_session_id="s1",
            message_id="m1",
            role="user",
            content="nothing here",
            time_created=1000,
        )
        search_db.add(row)
        search_db.commit()

        result = search_db.execute(
            text("SELECT id FROM part_index WHERE content REGEXP :pat"),
            {"pat": "xyz123"},
        ).fetchall()
        assert len(result) == 0


# ---------------------------------------------------------------------------
# sync_metadata round-trip
# ---------------------------------------------------------------------------


class TestSyncMetadata:
    def test_store_and_retrieve(self, search_db):
        search_db.add(SearchSyncMetadata(key="last_sync_time", value="1700000000000"))
        search_db.commit()

        row = search_db.get(SearchSyncMetadata, "last_sync_time")
        assert row is not None
        assert row.value == "1700000000000"
