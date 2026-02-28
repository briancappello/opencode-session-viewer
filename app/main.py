from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import Config
from app.db import (
    init_db,
    is_conversation_archived,
    set_conversation_archived,
)
from app.services import (
    format_timestamp,
    list_archived_conversations,
    list_conversations,
    list_directories,
    load_conversation_export,
    search_conversations,
)
from app.sync import sync_search_index


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: initialise databases and sync search index on startup."""
    init_db()
    sync_search_index()
    yield


app = FastAPI(title=Config.TITLE, lifespan=lifespan)

static_assets = StaticFiles(directory=str(Config.STATIC_ASSETS_DIR))
templates = Jinja2Templates(directory=str(Config.TEMPLATES_DIR))

# Mount static files
app.mount("/static", static_assets, name="static")


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, all: bool = False):
    conversations = list_conversations(show_all=all)

    display_conversations = []
    for s in conversations:
        s_dict = s.model_dump()

        # Shorten directory
        directory = s.directory or ""
        dir_short = directory
        if len(directory) > 40:
            dir_short = "..." + directory[-37:]

        s_dict["updated_formatted"] = format_timestamp(s.time_updated)
        s_dict["directory_short"] = dir_short
        display_conversations.append(s_dict)

    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {
            "conversations": display_conversations,
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
    """Search conversations using full-text search or regex."""
    results = search_conversations(query=q, directory=directory, limit=limit, regex=regex)
    return JSONResponse(
        content=[r.model_dump() for r in results],
    )


@app.get("/api/directories")
async def api_directories():
    """Get list of unique directories for filtering."""
    directories = list_directories()
    return JSONResponse(content=directories)


@app.post("/api/sync")
async def api_sync():
    """Trigger an incremental sync of the search index from the source database."""
    await run_in_threadpool(sync_search_index)
    return JSONResponse(content={"status": "ok"})


@app.post("/api/conversation/{conversation_id}/archive")
async def api_archive_conversation(conversation_id: str):
    """Archive a conversation (soft delete)."""
    set_conversation_archived(conversation_id, archived=True)
    return JSONResponse(
        content={"status": "archived", "conversation_id": conversation_id}
    )


@app.post("/api/conversation/{conversation_id}/unarchive")
async def api_unarchive_conversation(conversation_id: str):
    """Unarchive a conversation."""
    set_conversation_archived(conversation_id, archived=False)
    return JSONResponse(
        content={"status": "unarchived", "conversation_id": conversation_id}
    )


@app.get("/api/conversation/{conversation_id}/archived")
async def api_conversation_archived_status(conversation_id: str):
    """Check if a conversation is archived."""
    archived = is_conversation_archived(conversation_id)
    return JSONResponse(
        content={"conversation_id": conversation_id, "archived": archived}
    )


@app.get("/archived", response_class=HTMLResponse)
async def archived_conversations(request: Request):
    """View archived conversations."""
    conversations = list_archived_conversations()

    display_conversations = []
    for s in conversations:
        s_dict = s.model_dump()

        # Shorten directory
        directory = s.directory or ""
        dir_short = directory
        if len(directory) > 40:
            dir_short = "..." + directory[-37:]

        s_dict["updated_formatted"] = format_timestamp(s.time_updated)
        s_dict["directory_short"] = dir_short
        display_conversations.append(s_dict)

    return templates.TemplateResponse(
        request,
        "archived.html",
        {
            "conversations": display_conversations,
        },
    )


@app.get("/conversation/{conversation_id}", response_class=HTMLResponse)
async def view_conversation(request: Request, conversation_id: str):
    conversation_data = load_conversation_export(conversation_id)
    if conversation_data is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # We need to pass the JSON as a string to the template for injection
    # Escape forward slashes to prevent </script> attacks/breakage
    conversation_json = conversation_data.model_dump_json().replace("</", "<\\/")

    return templates.TemplateResponse(
        request,
        "conversation.html",
        {
            "conversation": conversation_data,
            "conversation_json": conversation_json,
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)
