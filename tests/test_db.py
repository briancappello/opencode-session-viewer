"""
Tests for app/db.py — the extensions (main.db) CRUD layer.
"""

from app.db import (
    Conversation,
    delete_conversation,
    ensure_conversation_exists,
    get_archived_conversation_ids,
    get_conversation,
    get_conversation_by_slug,
    is_conversation_archived,
    set_conversation_archived,
    upsert_conversation,
)


class TestEnsureConversationExists:
    def test_creates_row_when_missing(self, main_db, patched_config):
        ensure_conversation_exists("sess-new")
        row = get_conversation("sess-new")
        assert row is not None
        assert row.upstream_session_id == "sess-new"
        assert row.archived is False
        assert row.title is None
        assert row.slug is None

    def test_idempotent_does_not_overwrite_user_fields(self, main_db, patched_config):
        # Pre-populate with custom fields
        main_db.add(
            Conversation(
                upstream_session_id="sess-existing",
                title="My Title",
                slug="my-slug",
                archived=True,
            )
        )
        main_db.commit()

        # Calling ensure_conversation_exists should NOT touch user fields
        ensure_conversation_exists("sess-existing")
        row = get_conversation("sess-existing")
        assert row.title == "My Title"
        assert row.slug == "my-slug"
        assert row.archived is True


class TestGetConversation:
    def test_returns_none_for_missing(self, main_db, patched_config):
        assert get_conversation("does-not-exist") is None

    def test_returns_row(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-1"))
        main_db.commit()
        row = get_conversation("sess-1")
        assert row is not None
        assert row.upstream_session_id == "sess-1"


class TestGetConversationBySlug:
    def test_returns_none_when_no_match(self, main_db, patched_config):
        assert get_conversation_by_slug("nonexistent-slug") is None

    def test_returns_row_by_slug(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-slug", slug="my-slug"))
        main_db.commit()
        row = get_conversation_by_slug("my-slug")
        assert row is not None
        assert row.upstream_session_id == "sess-slug"

    def test_different_slug_not_matched(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-other", slug="other-slug"))
        main_db.commit()
        assert get_conversation_by_slug("wrong-slug") is None


class TestUpsertConversation:
    def test_creates_row_if_not_exists(self, main_db, patched_config):
        row = upsert_conversation("sess-upsert", title="New Title", slug="new-slug")
        assert row.upstream_session_id == "sess-upsert"
        assert row.title == "New Title"
        assert row.slug == "new-slug"

    def test_updates_title_only(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-u", slug="keep-this"))
        main_db.commit()
        row = upsert_conversation("sess-u", title="Updated Title")
        assert row.title == "Updated Title"
        assert row.slug == "keep-this"

    def test_updates_slug_only(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-u2", title="Keep Title"))
        main_db.commit()
        row = upsert_conversation("sess-u2", slug="new-slug")
        assert row.title == "Keep Title"
        assert row.slug == "new-slug"

    def test_clears_title_when_none_passed(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-u3", title="Old Title"))
        main_db.commit()
        row = upsert_conversation("sess-u3", title=None)
        assert row.title is None

    def test_omitting_title_leaves_it_unchanged(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-u4", title="Unchanged"))
        main_db.commit()
        # Pass only slug — title must be untouched
        row = upsert_conversation("sess-u4", slug="s")
        assert row.title == "Unchanged"


class TestDeleteConversation:
    def test_returns_false_when_not_found(self, main_db, patched_config):
        assert delete_conversation("no-such-id") is False

    def test_deletes_existing_row(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-del"))
        main_db.commit()
        assert delete_conversation("sess-del") is True
        assert get_conversation("sess-del") is None


class TestArchivedState:
    def test_archive_creates_row_if_missing(self, main_db, patched_config):
        set_conversation_archived("sess-arch", archived=True)
        assert is_conversation_archived("sess-arch") is True

    def test_unarchive_creates_row_if_missing(self, main_db, patched_config):
        set_conversation_archived("sess-unarch", archived=False)
        assert is_conversation_archived("sess-unarch") is False

    def test_archive_then_unarchive(self, main_db, patched_config):
        main_db.add(Conversation(upstream_session_id="sess-toggle"))
        main_db.commit()
        set_conversation_archived("sess-toggle", archived=True)
        assert is_conversation_archived("sess-toggle") is True
        set_conversation_archived("sess-toggle", archived=False)
        assert is_conversation_archived("sess-toggle") is False

    def test_is_archived_returns_false_for_missing_row(self, main_db, patched_config):
        assert is_conversation_archived("totally-unknown") is False


class TestGetArchivedConversationIds:
    def test_empty_when_none_archived(self, main_db, patched_config):
        main_db.add_all(
            [
                Conversation(upstream_session_id="a", archived=False),
                Conversation(upstream_session_id="b", archived=False),
            ]
        )
        main_db.commit()
        assert get_archived_conversation_ids() == set()

    def test_returns_only_archived_ids(self, main_db, patched_config):
        main_db.add_all(
            [
                Conversation(upstream_session_id="arch-1", archived=True),
                Conversation(upstream_session_id="arch-2", archived=True),
                Conversation(upstream_session_id="not-arch", archived=False),
            ]
        )
        main_db.commit()
        ids = get_archived_conversation_ids()
        assert ids == {"arch-1", "arch-2"}
