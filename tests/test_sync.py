"""
Tests for app/sync.py — the sync engine that copies upstream data into the
search index.
"""

import time

from sqlalchemy import select

from app.db_search import (
    SearchConversationIndex,
    SearchPartIndex,
    get_search_session,
)
from app.sync import (
    extract_text_from_part,
    get_last_sync_time,
    rebuild_search_index,
    set_last_sync_time,
    sync_conversation,
    sync_search_index,
)

from tests.conftest import (
    make_upstream_message,
    make_upstream_part,
    make_upstream_session,
)


# ---------------------------------------------------------------------------
# extract_text_from_part (pure function)
# ---------------------------------------------------------------------------


class TestExtractTextFromPart:
    def test_text_part_returns_text(self):
        part = make_upstream_part(part_type="text", text="hello world")
        assert extract_text_from_part(part) == "hello world"

    def test_non_text_part_returns_none(self):
        for part_type in ("tool-call", "tool-result", "image", "file"):
            part = make_upstream_part(part_type=part_type, text="irrelevant")
            assert extract_text_from_part(part) is None

    def test_text_part_with_none_text_returns_none(self):
        part = make_upstream_part(part_type="text", text=None)
        assert extract_text_from_part(part) is None


# ---------------------------------------------------------------------------
# get_last_sync_time / set_last_sync_time
# ---------------------------------------------------------------------------


class TestSyncMetadataHelpers:
    def test_get_returns_none_when_empty(self, search_db):
        assert get_last_sync_time(search_db) is None

    def test_set_then_get(self, search_db):
        set_last_sync_time(search_db, 1_700_000_000_000)
        search_db.commit()
        assert get_last_sync_time(search_db) == 1_700_000_000_000

    def test_update_overwrites(self, search_db):
        set_last_sync_time(search_db, 1_000)
        search_db.commit()
        set_last_sync_time(search_db, 2_000)
        search_db.commit()
        assert get_last_sync_time(search_db) == 2_000


# ---------------------------------------------------------------------------
# sync_conversation
# ---------------------------------------------------------------------------


class TestSyncConversation:
    def test_inserts_conversation_and_parts(self, upstream_db, main_db, search_db):
        sess = make_upstream_session(id="s1", title="My Session", directory="/proj")
        msg = make_upstream_message(id="m1", session_id="s1", role="user")
        part = make_upstream_part(id="p1", message_id="m1", text="searchable text")
        upstream_db.add_all([sess, msg, part])
        upstream_db.commit()

        count = sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        assert count == 1

        ci = search_db.get(SearchConversationIndex, "s1")
        assert ci is not None
        assert ci.title == "My Session"
        assert ci.directory == "/proj"

        pi_rows = search_db.scalars(
            select(SearchPartIndex).where(SearchPartIndex.upstream_session_id == "s1")
        ).all()
        assert len(pi_rows) == 1
        assert pi_rows[0].content == "searchable text"
        assert pi_rows[0].role == "user"

    def test_skips_non_user_assistant_messages(self, upstream_db, main_db, search_db):
        sess = make_upstream_session(id="s2")
        msg_sys = make_upstream_message(id="m-sys", session_id="s2", role="system")
        part_sys = make_upstream_part(id="p-sys", message_id="m-sys", text="system text")
        upstream_db.add_all([sess, msg_sys, part_sys])
        upstream_db.commit()

        count = sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        assert count == 0
        pi_rows = search_db.scalars(
            select(SearchPartIndex).where(SearchPartIndex.upstream_session_id == "s2")
        ).all()
        assert len(pi_rows) == 0

    def test_skips_non_text_parts(self, upstream_db, main_db, search_db):
        sess = make_upstream_session(id="s3")
        msg = make_upstream_message(id="m3", session_id="s3", role="assistant")
        tool_part = make_upstream_part(
            id="p-tool", message_id="m3", part_type="tool-call", text=None
        )
        upstream_db.add_all([sess, msg, tool_part])
        upstream_db.commit()

        count = sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        assert count == 0

    def test_skips_empty_text_parts(self, upstream_db, main_db, search_db):
        sess = make_upstream_session(id="s4")
        msg = make_upstream_message(id="m4", session_id="s4", role="user")
        empty_part = make_upstream_part(
            id="p-empty", message_id="m4", part_type="text", text="   "
        )
        upstream_db.add_all([sess, msg, empty_part])
        upstream_db.commit()

        count = sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        assert count == 0

    def test_re_sync_replaces_parts(self, upstream_db, main_db, search_db):
        """Re-syncing a conversation should delete old parts and insert fresh ones."""
        sess = make_upstream_session(id="s5")
        msg = make_upstream_message(id="m5", session_id="s5", role="user")
        part_old = make_upstream_part(id="p5-old", message_id="m5", text="old text")
        upstream_db.add_all([sess, msg, part_old])
        upstream_db.commit()

        # First sync
        sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        # Mutate upstream part text (simulate an update)
        part_old.data = '{"type": "text", "text": "new text"}'
        upstream_db.commit()

        # Second sync — old part_index rows must be replaced
        sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        pi_rows = search_db.scalars(
            select(SearchPartIndex).where(SearchPartIndex.upstream_session_id == "s5")
        ).all()
        assert len(pi_rows) == 1
        assert pi_rows[0].content == "new text"

    def test_creates_conversation_row_in_main_db(
        self, upstream_db, main_db, search_db, patched_config
    ):
        sess = make_upstream_session(id="s6")
        upstream_db.add(sess)
        upstream_db.commit()

        sync_conversation(upstream_db, search_db, sess)
        search_db.commit()

        from app.db import get_conversation

        row = get_conversation("s6")
        assert row is not None
        assert row.upstream_session_id == "s6"


# ---------------------------------------------------------------------------
# sync_search_index (integration)
# ---------------------------------------------------------------------------


class TestSyncSearchIndex:
    def test_full_sync_indexes_all_conversations(
        self, upstream_db, main_db, search_db, patched_config
    ):
        """A fresh sync with no last_sync_time must index every upstream session."""
        sess = make_upstream_session(id="full-1", title="Full Sync Test")
        msg = make_upstream_message(id="fm-1", session_id="full-1", role="user")
        part = make_upstream_part(id="fp-1", message_id="fm-1", text="full sync content")
        upstream_db.add_all([sess, msg, part])
        upstream_db.commit()

        sync_search_index()

        with get_search_session() as db:
            ci = db.get(SearchConversationIndex, "full-1")
            assert ci is not None
            pi_rows = db.scalars(
                select(SearchPartIndex).where(
                    SearchPartIndex.upstream_session_id == "full-1"
                )
            ).all()
            assert len(pi_rows) == 1

    def test_incremental_sync_only_picks_up_new_conversations(
        self, upstream_db, main_db, search_db, patched_config
    ):
        """After the first sync, a second sync should only process updated sessions."""
        now_ms = int(time.time() * 1000)

        sess_old = make_upstream_session(
            id="inc-old",
            title="Old Session",
            time_updated=now_ms - 10_000,
        )
        upstream_db.add(sess_old)
        upstream_db.commit()

        # First sync — picks up sess_old, records a last_sync_time ~now
        sync_search_index()

        # Add a new session *after* the first sync timestamp
        sess_new = make_upstream_session(
            id="inc-new",
            title="New Session",
            time_updated=now_ms + 5_000,
        )
        upstream_db.add(sess_new)
        upstream_db.commit()

        # Second (incremental) sync — should pick up sess_new
        sync_search_index()

        with get_search_session() as db:
            ci_new = db.get(SearchConversationIndex, "inc-new")
            assert ci_new is not None

    def test_no_sessions_is_a_noop(self, upstream_db, main_db, search_db, patched_config):
        """sync_search_index with an empty upstream DB must not raise."""
        sync_search_index()  # No sessions to sync — should return cleanly


# ---------------------------------------------------------------------------
# rebuild_search_index
# ---------------------------------------------------------------------------


class TestRebuildSearchIndex:
    def test_rebuild_deletes_and_recreates(
        self, upstream_db, main_db, search_db, patched_config
    ):
        sess = make_upstream_session(id="rb-1", title="Rebuild Test")
        msg = make_upstream_message(id="rbm-1", session_id="rb-1", role="user")
        part = make_upstream_part(id="rbp-1", message_id="rbm-1", text="rebuild content")
        upstream_db.add_all([sess, msg, part])
        upstream_db.commit()

        # First sync to populate the search DB
        sync_search_index()

        # Rebuild should delete the search DB file and re-sync from scratch
        rebuild_search_index()

        with get_search_session() as db:
            ci = db.get(SearchConversationIndex, "rb-1")
            assert ci is not None
            pi_rows = db.scalars(
                select(SearchPartIndex).where(
                    SearchPartIndex.upstream_session_id == "rb-1"
                )
            ).all()
            assert len(pi_rows) == 1
