"""
Tests for the FastAPI application routes in app/main.py.

The TestClient runs the real lifespan (init_db + sync_search_index), which
is fine — all three DB engines are already pointed at temp files by
``patched_config``, so startup just creates tables that already exist and
syncs zero new records from the empty upstream DB.
"""

import pytest

from fastapi.testclient import TestClient

import app.main as main_module

from app.db import set_conversation_archived


@pytest.fixture()
def client(populated_dbs, patched_config):
    """TestClient backed by the patched temp databases."""
    with TestClient(main_module.app, raise_server_exceptions=True) as c:
        yield c


# ---------------------------------------------------------------------------
# GET / — dashboard
# ---------------------------------------------------------------------------


class TestDashboard:
    def test_returns_200(self, client):
        resp = client.get("/")
        assert resp.status_code == 200

    def test_contains_session_title(self, client):
        resp = client.get("/")
        assert "First Session" in resp.text or "Second Session" in resp.text

    def test_archived_not_shown(self, client, patched_config):
        set_conversation_archived("sess-1", archived=True)
        resp = client.get("/")
        # sess-1's unique title should not appear on the dashboard
        assert "First Session" not in resp.text


# ---------------------------------------------------------------------------
# GET /archived
# ---------------------------------------------------------------------------


class TestArchivedPage:
    def test_returns_200(self, client):
        resp = client.get("/archived")
        assert resp.status_code == 200

    def test_shows_archived_conversation(self, client):
        set_conversation_archived("sess-1", archived=True)
        resp = client.get("/archived")
        assert "First Session" in resp.text


# ---------------------------------------------------------------------------
# GET /conversation/{id}
# ---------------------------------------------------------------------------


class TestConversationPage:
    def test_returns_200_for_known_id(self, client):
        resp = client.get("/conversation/sess-1")
        assert resp.status_code == 200

    def test_returns_404_for_unknown_id(self, client):
        resp = client.get("/conversation/no-such-id")
        assert resp.status_code == 404

    def test_contains_conversation_json(self, client):
        resp = client.get("/conversation/sess-1")
        assert "sess-1" in resp.text


# ---------------------------------------------------------------------------
# GET /api/search
# ---------------------------------------------------------------------------


class TestApiSearch:
    def test_missing_query_returns_422(self, client):
        resp = client.get("/api/search")
        assert resp.status_code == 422

    def test_returns_json_list(self, client):
        resp = client.get("/api/search", params={"q": "Hello"})
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    def test_empty_query_returns_empty_list(self, client):
        resp = client.get("/api/search", params={"q": "   "})
        assert resp.status_code == 200
        assert resp.json() == []

    def test_regex_flag_works(self, client):
        resp = client.get("/api/search", params={"q": "Hello.*user", "regex": "true"})
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list) and data

    def test_limit_param_respected(self, client):
        resp = client.get("/api/search", params={"q": "Hello", "limit": 1})
        assert resp.status_code == 200
        assert len(resp.json()) <= 1

    def test_directory_filter(self, client):
        resp = client.get("/api/search", params={"q": "Hello", "directory": "/proj/a"})
        assert resp.status_code == 200
        data = resp.json()
        for item in data:
            assert "/proj/b" not in (item.get("directory") or "")


# ---------------------------------------------------------------------------
# GET /api/directories
# ---------------------------------------------------------------------------


class TestApiDirectories:
    def test_returns_list_of_strings(self, client):
        resp = client.get("/api/directories")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        for d in data:
            assert isinstance(d, str)

    def test_contains_known_directories(self, client):
        resp = client.get("/api/directories")
        dirs = resp.json()
        assert "/proj/a" in dirs
        assert "/proj/b" in dirs


# ---------------------------------------------------------------------------
# POST /api/sync
# ---------------------------------------------------------------------------


class TestApiSync:
    def test_returns_ok(self, client):
        resp = client.post("/api/sync")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# POST /api/conversation/{id}/archive
# ---------------------------------------------------------------------------


class TestApiArchive:
    def test_archives_conversation(self, client):
        resp = client.post("/api/conversation/sess-1/archive")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "archived"
        assert data["conversation_id"] == "sess-1"

        # Verify via status endpoint
        status_resp = client.get("/api/conversation/sess-1/archived")
        assert status_resp.json()["archived"] is True

    def test_archive_nonexistent_creates_row(self, client):
        """Archiving an unknown ID should still succeed (creates the row)."""
        resp = client.post("/api/conversation/brand-new-id/archive")
        assert resp.status_code == 200


# ---------------------------------------------------------------------------
# POST /api/conversation/{id}/unarchive
# ---------------------------------------------------------------------------


class TestApiUnarchive:
    def test_unarchives_conversation(self, client):
        # First archive it
        client.post("/api/conversation/sess-1/archive")

        resp = client.post("/api/conversation/sess-1/unarchive")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "unarchived"

        status_resp = client.get("/api/conversation/sess-1/archived")
        assert status_resp.json()["archived"] is False


# ---------------------------------------------------------------------------
# GET /api/conversation/{id}/archived
# ---------------------------------------------------------------------------


class TestApiArchivedStatus:
    def test_not_archived_by_default(self, client):
        resp = client.get("/api/conversation/sess-1/archived")
        assert resp.status_code == 200
        data = resp.json()
        assert data["conversation_id"] == "sess-1"
        assert data["archived"] is False

    def test_reflects_archived_state(self, client):
        set_conversation_archived("sess-2", archived=True)
        resp = client.get("/api/conversation/sess-2/archived")
        assert resp.json()["archived"] is True

    def test_unknown_id_returns_false(self, client):
        resp = client.get("/api/conversation/unknown-xyz/archived")
        assert resp.status_code == 200
        assert resp.json()["archived"] is False
