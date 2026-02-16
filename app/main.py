from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates

from app.services import load_session_export, format_timestamp, get_storage_path, list_sessions


app = FastAPI(title="OpenCode Session Viewer")

BASE_DIR = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


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
