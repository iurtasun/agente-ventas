"""API HTTP del agente de ventas y servidor del frontend."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .agent import SalesAgent, SessionBusyError
from .config import (
    DB_PATH,
    DEFAULT_MODEL,
    SESSION_TTL_MINUTES,
    STATIC_DIR,
    api_key,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("agente.ventas")

agent = SalesAgent()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await agent.start()

    async def sweeper() -> None:
        while True:
            await asyncio.sleep(300)
            try:
                removed = await agent.sweep_idle(SESSION_TTL_MINUTES)
                if removed:
                    logger.info("Sesiones inactivas cerradas: %s", removed)
            except Exception:  # noqa: BLE001
                logger.exception("Error limpiando sesiones inactivas")

    task = asyncio.create_task(sweeper())
    try:
        yield
    finally:
        task.cancel()
        await agent.stop()


app = FastAPI(title="Agente de ventas", version="1.0.0", lifespan=lifespan)


class NewSessionRequest(BaseModel):
    model: str | None = Field(default=None, description="Modelo de OpenRouter")


class MessageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/health")
async def health() -> dict:
    return {
        "ok": True,
        "api_key_configured": bool(api_key()),
        "db_present": DB_PATH.is_file(),
        "default_model": DEFAULT_MODEL,
        "active_sessions": len(agent.sessions),
    }


@app.post("/api/sessions", status_code=201)
async def create_session(body: NewSessionRequest | None = None) -> dict:
    if not api_key():
        raise HTTPException(
            status_code=503,
            detail="Falta OPENROUTER_API_KEY. Crea un .env con tu clave.",
        )
    if not DB_PATH.is_file():
        raise HTTPException(status_code=503, detail=f"No existe la base de datos: {DB_PATH}")
    try:
        session = await agent.create_session(body.model if body else None)
    except Exception as exc:  # noqa: BLE001
        logger.exception("No se pudo crear la sesión")
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return session.summary()


@app.get("/api/sessions")
async def list_sessions() -> dict:
    # Solo las conversaciones que ya tienen algún mensaje.
    return {"sessions": [s.summary() for s in agent.sessions.values() if s.messages]}


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    session = agent.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    return {**session.summary(), "messages": session.messages}


@app.delete("/api/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str) -> None:
    if not await agent.delete_session(session_id):
        raise HTTPException(status_code=404, detail="Sesión no encontrada")


@app.post("/api/sessions/{session_id}/messages")
async def post_message(session_id: str, body: MessageRequest) -> StreamingResponse:
    session = agent.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")
    if session.busy:
        raise HTTPException(status_code=409, detail="La sesión ya está procesando un turno")

    async def events() -> AsyncIterator[str]:
        try:
            async for item in session.stream_turn(body.prompt):
                yield _sse(item["event"], item["data"])
        except SessionBusyError as exc:
            yield _sse("error", {"message": str(exc)})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("Fallo durante el turno")
            yield _sse("error", {"message": str(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
