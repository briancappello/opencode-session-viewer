"""
Tests for app/services.py — the business-logic layer.
"""

import json
import re

from app.db import Conversation
from app.db_search import SearchConversationIndex, SearchPartIndex
from app.db_upstream import UpstreamPart
from app.models import ConversationSummary
from app.services import (
    _apply_extensions,
    _escape_fts5_query,
    _generate_snippet,
    format_timestamp,
    list_archived_conversations,
    list_conversations,
    list_directories,
    load_conversation_export,
    search_conversations,
)

from tests.conftest import (
    make_upstream_message,
    make_upstream_part,
    make_upstream_session,
)


# ---------------------------------------------------------------------------
# format_timestamp
# ---------------------------------------------------------------------------


class TestFormatTimestamp:
    def test_formats_ms_timestamp(self):
        # 2023-11-14 22:13:20 UTC (exact value depends on local timezone — just
        # verify the shape: YYYY-MM-DD HH:MM)
        result = format_timestamp(1_700_000_000_000)
        assert len(result) == 16
        assert result[4] == "-"
        assert result[7] == "-"
        assert result[10] == " "
        assert result[13] == ":"

    def test_none_returns_unknown(self):
        assert format_timestamp(None) == "Unknown"

    def test_zero_returns_unknown(self):
        assert format_timestamp(0) == "Unknown"


# ---------------------------------------------------------------------------
# _escape_fts5_query
# ---------------------------------------------------------------------------


class TestEscapeFts5Query:
    def test_wraps_in_double_quotes(self):
        assert _escape_fts5_query("hello world") == '"hello world"'

    def test_escapes_internal_double_quotes(self):
        assert _escape_fts5_query('say "hello"') == '"say ""hello"""'

    def test_empty_string(self):
        assert _escape_fts5_query("") == '""'


# ---------------------------------------------------------------------------
# _generate_snippet
# ---------------------------------------------------------------------------


class TestGenerateSnippet:
    def test_match_in_middle_has_markers(self):
        content = "abc def target ghi jkl"
        pattern = re.compile("target", re.IGNORECASE)
        snippet = _generate_snippet(content, pattern, snippet_length=50)
        assert "<<MATCH>>target<<END>>" in snippet

    def test_no_match_returns_truncated(self):
        content = "a" * 200
        pattern = re.compile("NOMATCH", re.IGNORECASE)
        snippet = _generate_snippet(content, pattern, snippet_length=100)
        assert len(snippet) <= 104  # 100 chars + "..."
        assert "<<MATCH>>" not in snippet

    def test_short_content_no_ellipsis(self):
        content = "short"
        pattern = re.compile("NOMATCH", re.IGNORECASE)
        snippet = _generate_snippet(content, pattern, snippet_length=100)
        assert snippet == "short"

    def test_case_insensitive_match(self):
        content = "Hello World"
        pattern = re.compile("hello", re.IGNORECASE)
        snippet = _generate_snippet(content, pattern)
        assert "<<MATCH>>Hello<<END>>" in snippet


# ---------------------------------------------------------------------------
# _apply_extensions
# ---------------------------------------------------------------------------


class TestApplyExtensions:
    def _make_summary(self, title="Upstream Title", slug=None):
        return ConversationSummary(id="s1", title=title, slug=slug, directory="/proj")

    def test_overrides_title_when_set(self):
        summary = self._make_summary()
        conv = Conversation(upstream_session_id="s1", title="Custom Title")
        _apply_extensions(summary, conv)
        assert summary.title == "Custom Title"

    def test_does_not_override_title_when_none(self):
        summary = self._make_summary(title="Upstream")
        conv = Conversation(upstream_session_id="s1", title=None)
        _apply_extensions(summary, conv)
        assert summary.title == "Upstream"

    def test_overrides_slug_when_set(self):
        summary = self._make_summary()
        conv = Conversation(upstream_session_id="s1", slug="custom-slug")
        _apply_extensions(summary, conv)
        assert summary.slug == "custom-slug"

    def test_does_not_override_slug_when_none(self):
        summary = self._make_summary(slug="upstream-slug")
        conv = Conversation(upstream_session_id="s1", slug=None)
        _apply_extensions(summary, conv)
        assert summary.slug == "upstream-slug"


# ---------------------------------------------------------------------------
# list_conversations
# ---------------------------------------------------------------------------


class TestListConversations:
    def test_returns_conversations(self, populated_dbs):
        conversations = list_conversations()
        assert len(conversations) == 2

    def test_excludes_archived(self, populated_dbs):
        from app.db import set_conversation_archived

        set_conversation_archived("sess-1", archived=True)
        conversations = list_conversations()
        ids = [c.id for c in conversations]
        assert "sess-1" not in ids
        assert "sess-2" in ids

    def test_excludes_subagent_sessions(self, populated_dbs, upstream_db, main_db):
        # Add a session with "subagent" in the title
        sub = make_upstream_session(id="sess-sub", title="subagent helper session")
        upstream_db.add(sub)
        upstream_db.commit()
        main_db.add(Conversation(upstream_session_id="sess-sub", archived=False))
        main_db.commit()

        conversations = list_conversations(show_all=False)
        ids = [c.id for c in conversations]
        assert "sess-sub" not in ids

    def test_show_all_includes_subagents(self, populated_dbs, upstream_db, main_db):
        sub = make_upstream_session(id="sess-sub2", title="subagent task")
        upstream_db.add(sub)
        upstream_db.commit()
        main_db.add(Conversation(upstream_session_id="sess-sub2", archived=False))
        main_db.commit()

        conversations = list_conversations(show_all=True)
        ids = [c.id for c in conversations]
        assert "sess-sub2" in ids

    def test_sorted_by_time_updated_desc(self, populated_dbs):
        conversations = list_conversations()
        times = [c.time_updated for c in conversations if c.time_updated]
        assert times == sorted(times, reverse=True)


# ---------------------------------------------------------------------------
# list_archived_conversations
# ---------------------------------------------------------------------------


class TestListArchivedConversations:
    def test_empty_when_none_archived(self, populated_dbs):
        result = list_archived_conversations()
        assert result == []

    def test_returns_only_archived(self, populated_dbs):
        from app.db import set_conversation_archived

        set_conversation_archived("sess-1", archived=True)
        result = list_archived_conversations()
        ids = [c.id for c in result]
        assert "sess-1" in ids
        assert "sess-2" not in ids


# ---------------------------------------------------------------------------
# load_conversation_export
# ---------------------------------------------------------------------------


class TestLoadConversationExport:
    def test_returns_none_for_unknown_id(self, populated_dbs):
        result = load_conversation_export("no-such-id")
        assert result is None

    def test_returns_export_for_known_id(self, populated_dbs):
        result = load_conversation_export("sess-1")
        assert result is not None
        assert result.summary.id == "sess-1"

    def test_export_has_messages(self, populated_dbs):
        result = load_conversation_export("sess-1")
        assert result is not None
        assert len(result.messages) >= 1

    def test_extension_title_applied(self, populated_dbs, main_db):
        # Give sess-1 a custom title via the extensions DB
        from app.db import upsert_conversation

        upsert_conversation("sess-1", title="Custom Export Title")
        result = load_conversation_export("sess-1")
        assert result is not None
        assert result.summary.title == "Custom Export Title"

    def test_export_includes_linked_subagent_transcript(self, populated_dbs, upstream_db):
        child = make_upstream_session(
            id="sub-1",
            title="Inspect files (@general subagent)",
            parent_id="sess-1",
            time_created=1_700_000_000_700,
        )
        task_msg = make_upstream_message(
            id="msg-task",
            session_id="sess-1",
            role="assistant",
            time_created=1_700_000_000_650,
        )
        task_part = UpstreamPart(
            id="part-task",
            message_id="msg-task",
            data=json.dumps(
                {
                    "type": "tool",
                    "tool": "task",
                    "state": {
                        "input": {
                            "subagent_type": "general",
                            "description": "Inspect files",
                            "prompt": "Inspect files",
                        },
                        "metadata": {"sessionId": "sub-1"},
                        "status": "completed",
                    },
                }
            ),
            time_created=1_700_000_000_660,
        )
        child_msg = make_upstream_message(
            id="sub-msg-1",
            session_id="sub-1",
            role="assistant",
            time_created=1_700_000_000_800,
        )
        child_part = make_upstream_part(
            id="sub-part-1",
            message_id="sub-msg-1",
            text="subagent transcript body",
            time_created=1_700_000_000_810,
        )
        upstream_db.add_all([child, task_msg, task_part, child_msg, child_part])
        upstream_db.commit()

        result = load_conversation_export("sess-1")

        assert result is not None
        assert len(result.subagent_transcripts) == 1
        transcript = result.subagent_transcripts[0]
        assert transcript.summary.id == "sub-1"
        assert transcript.task_part_id == "part-task"
        assert transcript.task_message_id == "msg-task"
        assert transcript.agent_type == "general"
        assert transcript.messages[0].parts[0].text == "subagent transcript body"

    def test_export_infers_subagent_task_link_without_session_metadata(
        self, populated_dbs, upstream_db
    ):
        child = make_upstream_session(
            id="sub-inferred",
            title="Inspect files (@general subagent)",
            parent_id="sess-1",
            time_created=1_700_000_000_700,
        )
        task_msg = make_upstream_message(
            id="msg-task-inferred",
            session_id="sess-1",
            role="assistant",
            time_created=1_700_000_000_650,
        )
        task_part = UpstreamPart(
            id="part-task-inferred",
            message_id="msg-task-inferred",
            data=json.dumps(
                {
                    "type": "tool",
                    "tool": "task",
                    "state": {
                        "input": {
                            "subagent_type": "general",
                            "description": "Inspect files",
                            "prompt": "Inspect files",
                        },
                        "metadata": {},
                        "status": "completed",
                    },
                }
            ),
            time_created=1_700_000_000_660,
        )
        child_msg = make_upstream_message(
            id="sub-msg-inferred",
            session_id="sub-inferred",
            role="assistant",
            time_created=1_700_000_000_800,
        )
        child_part = make_upstream_part(
            id="sub-part-inferred",
            message_id="sub-msg-inferred",
            text="subagent transcript body",
            time_created=1_700_000_000_810,
        )
        upstream_db.add_all([child, task_msg, task_part, child_msg, child_part])
        upstream_db.commit()

        result = load_conversation_export("sess-1")

        assert result is not None
        assert len(result.subagent_transcripts) == 1
        transcript = result.subagent_transcripts[0]
        assert transcript.summary.id == "sub-inferred"
        assert transcript.task_part_id == "part-task-inferred"
        assert transcript.task_message_id == "msg-task-inferred"
        assert transcript.agent_type == "general"

    def test_export_includes_unlinked_child_session(self, populated_dbs, upstream_db):
        child = make_upstream_session(
            id="sub-unlinked",
            title="Detached subagent",
            parent_id="sess-1",
            time_created=1_700_000_000_700,
        )
        child_msg = make_upstream_message(
            id="sub-unlinked-msg",
            session_id="sub-unlinked",
            role="assistant",
        )
        child_part = make_upstream_part(
            id="sub-unlinked-part",
            message_id="sub-unlinked-msg",
            text="fallback child transcript",
        )
        upstream_db.add_all([child, child_msg, child_part])
        upstream_db.commit()

        result = load_conversation_export("sess-1")

        assert result is not None
        assert [t.summary.id for t in result.subagent_transcripts] == ["sub-unlinked"]


# ---------------------------------------------------------------------------
# search_conversations — FTS5 path
# ---------------------------------------------------------------------------


class TestSearchConversationsFts:
    def test_finds_match(self, populated_dbs):
        results = search_conversations("Hello")
        assert len(results) >= 1
        ids = [r.conversation_id for r in results]
        assert "sess-1" in ids or "sess-2" in ids

    def test_empty_query_returns_empty(self, populated_dbs):
        results = search_conversations("   ")
        assert results == []

    def test_no_match_returns_empty(self, populated_dbs):
        results = search_conversations("zzznomatch")
        assert results == []

    def test_excludes_archived(self, populated_dbs):
        from app.db import set_conversation_archived

        set_conversation_archived("sess-1", archived=True)
        results = search_conversations("Hello from user")
        ids = [r.conversation_id for r in results]
        assert "sess-1" not in ids

    def test_directory_filter(self, populated_dbs):
        results = search_conversations("Hello", directory="/proj/a")
        ids = [r.conversation_id for r in results]
        assert "sess-2" not in ids

    def test_child_transcript_match_links_to_parent(self, populated_dbs, search_db):
        child_index = SearchConversationIndex(
            id="sub-search",
            parent_id="sess-1",
            title="Search helper (@general subagent)",
            directory="/proj/a",
            time_updated=1_700_000_001_500,
        )
        child_part = SearchPartIndex(
            id="sub-search-part",
            upstream_session_id="sub-search",
            message_id="sub-search-msg",
            role="assistant",
            content="needle from child transcript",
            time_created=1_700_000_001_400,
        )
        search_db.add_all([child_index, child_part])
        search_db.commit()

        results = search_conversations("needle")

        assert len(results) == 1
        assert results[0].conversation_id == "sess-1"
        assert results[0].title == "First Session"
        assert results[0].matches[0].session_id == "sub-search"
        assert results[0].matches[0].session_title == "Search helper (@general subagent)"

    def test_total_matches_incremented(self, populated_dbs):
        results = search_conversations("Hello")
        for r in results:
            assert r.total_matches >= 1

    def test_no_search_data_returns_empty(self, main_db, patched_config):
        """When the search index has no data, return an empty list."""
        results = search_conversations("anything")
        assert results == []


# ---------------------------------------------------------------------------
# search_conversations — regex path
# ---------------------------------------------------------------------------


class TestSearchConversationsRegex:
    def test_regex_finds_match(self, populated_dbs):
        results = search_conversations("Hello.*user", regex=True)
        assert len(results) >= 1

    def test_invalid_regex_returns_empty(self, populated_dbs):
        results = search_conversations("[invalid", regex=True)
        assert results == []

    def test_regex_excludes_archived(self, populated_dbs):
        from app.db import set_conversation_archived

        set_conversation_archived("sess-2", archived=True)
        results = search_conversations("Hello.*assistant", regex=True)
        ids = [r.conversation_id for r in results]
        assert "sess-2" not in ids

    def test_regex_directory_filter(self, populated_dbs):
        results = search_conversations("Hello", directory="/proj/b", regex=True)
        ids = [r.conversation_id for r in results]
        assert "sess-1" not in ids

    def test_regex_child_transcript_match_links_to_parent(self, populated_dbs, search_db):
        child_index = SearchConversationIndex(
            id="sub-regex",
            parent_id="sess-1",
            title="Regex helper",
            directory="/proj/a",
            time_updated=1_700_000_001_500,
        )
        child_part = SearchPartIndex(
            id="sub-regex-part",
            upstream_session_id="sub-regex",
            message_id="sub-regex-msg",
            role="assistant",
            content="regex child transcript",
            time_created=1_700_000_001_400,
        )
        search_db.add_all([child_index, child_part])
        search_db.commit()

        results = search_conversations("regex.*transcript", regex=True)

        assert len(results) == 1
        assert results[0].conversation_id == "sess-1"
        assert results[0].matches[0].session_id == "sub-regex"


# ---------------------------------------------------------------------------
# list_directories
# ---------------------------------------------------------------------------


class TestListDirectories:
    def test_returns_unique_directories(self, populated_dbs):
        dirs = list_directories()
        assert "/proj/a" in dirs
        assert "/proj/b" in dirs

    def test_no_duplicates(self, populated_dbs):
        dirs = list_directories()
        assert len(dirs) == len(set(dirs))

    def test_no_search_data_returns_empty(self, main_db, search_db, patched_config):
        dirs = list_directories()
        assert dirs == []
