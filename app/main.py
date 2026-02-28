from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.search_db import is_session_archived, set_session_archived
from app.services import (
    format_timestamp,
    get_storage_path,
    list_archived_sessions,
    list_directories,
    list_sessions,
    load_session_export,
    search_sessions,
)
from app.sync import sync_search_index


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: sync search index on startup."""
    sync_search_index()
    yield


app = FastAPI(title="OpenCode Session Viewer", lifespan=lifespan)

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# Mount static files
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, all: bool = False):
    storage_path = get_storage_path()

    if not storage_path.exists():
        return templates.TemplateResponse(
            "dashboard.html",
            {"request": request, "sessions": [], "error": "Storage path not found"},
        )

    sessions = list_sessions(storage_path, show_all=all)

    display_sessions = []
    for s in sessions:
        s_dict = s.model_dump()

        # Shorten directory
        directory = s.directory or ""
        dir_short = directory
        if len(directory) > 40:
            dir_short = "..." + directory[-37:]

        s_dict["updated_formatted"] = format_timestamp(s.time_updated)
        s_dict["directory_short"] = dir_short
        display_sessions.append(s_dict)

    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "sessions": display_sessions,
            "show_all": all,
        },
    )


@app.get("/api/search")
async def api_search(
    q: str = Query(..., description="Search query"),
    directory: Optional[str] = Query(None, description="Filter by directory"),
    limit: int = Query(50, ge=1, le=200, description="Max results"),
    regex: bool = Query(False, description="Use regex search instead of plaintext"),
):
    """Search sessions using full-text search or regex."""
    results = search_sessions(query=q, directory=directory, limit=limit, regex=regex)
    return JSONResponse(
        content=[r.model_dump() for r in results],
    )


@app.get("/api/directories")
async def api_directories():
    """Get list of unique directories for filtering."""
    directories = list_directories()
    return JSONResponse(content=directories)


@app.post("/api/session/{session_id}/archive")
async def api_archive_session(session_id: str):
    """Archive a session (soft delete)."""
    success = set_session_archived(session_id, archived=True)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found in index")
    return JSONResponse(content={"status": "archived", "session_id": session_id})


@app.post("/api/session/{session_id}/unarchive")
async def api_unarchive_session(session_id: str):
    """Unarchive a session."""
    success = set_session_archived(session_id, archived=False)
    if not success:
        raise HTTPException(status_code=404, detail="Session not found in index")
    return JSONResponse(content={"status": "unarchived", "session_id": session_id})


@app.get("/api/session/{session_id}/archived")
async def api_session_archived_status(session_id: str):
    """Check if a session is archived."""
    archived = is_session_archived(session_id)
    return JSONResponse(content={"session_id": session_id, "archived": archived})


@app.get("/archived", response_class=HTMLResponse)
async def archived_sessions(request: Request):
    """View archived sessions."""
    storage_path = get_storage_path()

    sessions = list_archived_sessions(storage_path)

    display_sessions = []
    for s in sessions:
        s_dict = s.model_dump()

        # Shorten directory
        directory = s.directory or ""
        dir_short = directory
        if len(directory) > 40:
            dir_short = "..." + directory[-37:]

        s_dict["updated_formatted"] = format_timestamp(s.time_updated)
        s_dict["directory_short"] = dir_short
        display_sessions.append(s_dict)

    return templates.TemplateResponse(
        "archived.html",
        {
            "request": request,
            "sessions": display_sessions,
        },
    )


@app.get("/session/{session_id}", response_class=HTMLResponse)
async def view_session(request: Request, session_id: str):
    storage_path = get_storage_path()

    try:
        session_data = load_session_export(storage_path, session_id)

        # We need to pass the JSON as a string to the template for injection
        # Escape forward slashes to prevent </script> attacks/breakage
        session_json = session_data.model_dump_json().replace("</", "<\\/")

        return templates.TemplateResponse(
            "session.html",
            {
                "request": request,
                "session": session_data,
                "session_json": session_json,
            },
        )
    except ValueError:
        raise HTTPException(status_code=404, detail="Session not found")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
