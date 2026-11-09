"""Envoltorio del SDK de Copilot: un cliente compartido y una sesión por conversación."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from copilot import CopilotClient
from copilot.session import PermissionHandler
from copilot.session_events import SessionEventType

from .config import (
    DEFAULT_MODEL,
    OPENROUTER_BASE_URL,
    ROOT,
    TURN_TIMEOUT_SECONDS,
    require_api_key,
)
from .tools import query_sales

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """Eres un analista de datos de ventas con acceso a una base SQLite.
Tabla sales: Store_Number INTEGER, SKU_Coded INTEGER,
Product_Class_Code INTEGER, Sold_Date TEXT (AAAA-MM-DD),
Qty_Sold INTEGER, Total_Sale_Value REAL, On_Promo INTEGER (1/0).
Responde en español. Para cada pregunta sobre los datos, usa query_sales antes de
responder. Genera únicamente consultas SELECT sobre sales. Limita resultados
detallados a 100 filas. Da formato claro a las cifras monetarias e indica tus
suposiciones cuando la pregunta sea ambigua.
"""


class SessionBusyError(RuntimeError):
    """Ya hay un turno en curso en esta sesión."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class ChatSession:
    """Una conversación con su propia sesión del SDK y su historial."""

    id: str
    sdk_session: Any
    loop: asyncio.AbstractEventLoop
    model: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=_now_iso)
    last_used_at: str = field(default_factory=_now_iso)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    @property
    def title(self) -> str:
        for message in self.messages:
            if message["role"] == "user" and message["content"].strip():
                text = message["content"].strip().replace("\n", " ")
                return text if len(text) <= 60 else text[:57] + "…"
        return "Nueva conversación"

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "model": self.model,
            "created_at": self.created_at,
            "last_used_at": self.last_used_at,
            "message_count": sum(1 for m in self.messages if m["role"] != "tool"),
            "busy": self.busy,
        }

    async def close(self) -> None:
        try:
            await self.sdk_session.disconnect()
        except Exception:  # noqa: BLE001 - el cierre nunca debe romper el servidor
            logger.debug("Error cerrando la sesión %s", self.id, exc_info=True)

    async def stream_turn(self, prompt: str) -> AsyncIterator[dict[str, Any]]:
        """Envía un turno y produce eventos ya normalizados para el transporte.

        Cada elemento es ``{"event": nombre, "data": {...}}`` con uno de estos
        nombres: ``delta``, ``tool_start``, ``tool_end``, ``done`` o ``error``.
        """
        if self._lock.locked():
            raise SessionBusyError("La sesión ya está procesando un turno")

        async with self._lock:
            self.last_used_at = _now_iso()
            self.messages.append(
                {"role": "user", "content": prompt, "at": _now_iso()}
            )
            queue: asyncio.Queue[Any] = asyncio.Queue()

            def _push(event: Any) -> None:
                # El SDK entrega los eventos desde su propio hilo.
                try:
                    self.loop.call_soon_threadsafe(queue.put_nowait, event)
                except RuntimeError:
                    # El bucle se cerró mientras llegaba el evento.
                    pass

            unsubscribe = self.sdk_session.on(_push)
            # Cada mensaje del asistente es un "segmento". Los intermedios (el
            # modelo piensa en voz alta entre llamadas a herramientas) se
            # pliegan; el último es la respuesta.
            segments: list[dict[str, str]] = []
            current_message_id: str | None = None
            turn_tools: list[dict[str, Any]] = []
            try:
                await self.sdk_session.send(prompt)

                while True:
                    try:
                        event = await asyncio.wait_for(
                            queue.get(), timeout=TURN_TIMEOUT_SECONDS
                        )
                    except asyncio.TimeoutError:
                        yield {
                            "event": "error",
                            "data": {"message": "El agente tardó demasiado en responder"},
                        }
                        return

                    etype = event.type

                    if etype == SessionEventType.ASSISTANT_MESSAGE_DELTA:
                        message_id = getattr(event.data, "message_id", "") or ""
                        text = getattr(event.data, "delta_content", "") or ""
                        if not text:
                            continue
                        if message_id != current_message_id:
                            current_message_id = message_id
                            segments.append({"id": message_id, "text": ""})
                            yield {"event": "segment_start", "data": {"id": message_id}}
                        segments[-1]["text"] += text
                        yield {"event": "delta", "data": {"text": text}}

                    elif etype == SessionEventType.ASSISTANT_MESSAGE:
                        message_id = getattr(event.data, "message_id", "") or ""
                        content = getattr(event.data, "content", "") or ""
                        if not content:
                            continue
                        segment = next(
                            (s for s in segments if s["id"] == message_id), None
                        )
                        if segment is None:
                            # Proveedor sin streaming incremental: emitimos el bloque entero.
                            segments.append({"id": message_id, "text": content})
                            current_message_id = message_id
                            yield {"event": "segment_start", "data": {"id": message_id}}
                            yield {"event": "delta", "data": {"text": content}}
                        else:
                            segment["text"] = content

                    elif etype == SessionEventType.TOOL_EXECUTION_START:
                        tool_call_id = getattr(event.data, "tool_call_id", "")
                        tool_name = getattr(event.data, "tool_name", "")
                        arguments = _jsonable(getattr(event.data, "arguments", None))
                        turn_tools.append(
                            {
                                "id": tool_call_id,
                                "name": tool_name,
                                "arguments": arguments,
                                "success": None,
                            }
                        )
                        yield {
                            "event": "tool_start",
                            "data": {
                                "id": tool_call_id,
                                "name": tool_name,
                                "arguments": arguments,
                            },
                        }

                    elif etype == SessionEventType.TOOL_EXECUTION_COMPLETE:
                        tool_call_id = getattr(event.data, "tool_call_id", "")
                        success = bool(getattr(event.data, "success", False))
                        result = getattr(event.data, "result", None)
                        error = getattr(event.data, "error", None)
                        payload = _jsonable(
                            getattr(result, "content", None) if result else None
                        )
                        error_message = (
                            getattr(error, "message", None) if error else None
                        )
                        for tool in turn_tools:
                            if tool["id"] == tool_call_id:
                                tool["success"] = success
                        yield {
                            "event": "tool_end",
                            "data": {
                                "id": tool_call_id,
                                "success": success,
                                "result": payload,
                                "error": error_message,
                            },
                        }

                    elif etype == SessionEventType.SESSION_ERROR:
                        message = getattr(event.data, "message", "") or "Error de sesión"
                        yield {"event": "error", "data": {"message": message}}
                        break

                    elif etype == SessionEventType.SESSION_IDLE:
                        break

            except asyncio.CancelledError:
                try:
                    await self.sdk_session.abort()
                except Exception:  # noqa: BLE001
                    logger.debug("No se pudo abortar la sesión %s", self.id, exc_info=True)
                raise
            finally:
                unsubscribe()

            filled = [s for s in segments if s["text"].strip()]
            if filled or turn_tools:
                self.messages.append(
                    {
                        "role": "assistant",
                        "content": filled[-1]["text"].strip() if filled else "",
                        "thinking": "\n\n".join(s["text"].strip() for s in filled[:-1]),
                        "tools": turn_tools,
                        "at": _now_iso(),
                    }
                )
            self.last_used_at = _now_iso()
            yield {"event": "done", "data": {"at": self.last_used_at}}


def _jsonable(value: Any) -> Any:
    """Convierte valores del SDK en algo serializable y de tamaño acotado."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return str(value)


class SalesAgent:
    """Cliente compartido de Copilot que crea y custodia las conversaciones."""

    def __init__(self) -> None:
        self._client: CopilotClient | None = None
        self.sessions: dict[str, ChatSession] = {}
        self._starting: asyncio.Lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._starting:
            if self._client is not None:
                return
            client = CopilotClient(
                mode="empty",
                working_directory=str(ROOT),
                base_directory=str(ROOT / ".copilot-state"),
                log_level="error",
            )
            await client.start()
            self._client = client

    async def stop(self) -> None:
        for session in list(self.sessions.values()):
            await session.close()
        self.sessions.clear()
        if self._client is not None:
            await self._client.stop()
            self._client = None

    def _require_client(self) -> CopilotClient:
        if self._client is None:
            raise RuntimeError("El agente no está iniciado")
        return self._client

    async def create_session(self, model: str | None = None) -> ChatSession:
        await self.start()
        client = self._require_client()
        model = model or DEFAULT_MODEL
        sdk_session = await client.create_session(
            on_permission_request=PermissionHandler.approve_all,
            model=model,
            provider={
                "type": "openai",
                "base_url": OPENROUTER_BASE_URL,
                "wire_api": "responses",
                "api_key": require_api_key(),
            },
            streaming=True,
            tools=[query_sales],
            available_tools=["custom:query_sales"],
            system_message={"mode": "replace", "content": SYSTEM_PROMPT},
        )
        session = ChatSession(
            id=uuid.uuid4().hex,
            sdk_session=sdk_session,
            loop=asyncio.get_running_loop(),
            model=model,
        )
        self.sessions[session.id] = session
        return session

    def get(self, session_id: str) -> ChatSession | None:
        return self.sessions.get(session_id)

    async def delete_session(self, session_id: str) -> bool:
        session = self.sessions.pop(session_id, None)
        if session is None:
            return False
        await session.close()
        return True

    async def sweep_idle(self, ttl_minutes: int) -> int:
        """Cierra y descarta las sesiones inactivas. Devuelve cuántas eliminó."""
        from datetime import datetime as _dt

        now = _dt.now(timezone.utc)
        removed = 0
        for session_id, session in list(self.sessions.items()):
            if session.busy:
                continue
            try:
                last_used = _dt.fromisoformat(session.last_used_at)
            except ValueError:
                continue
            if (now - last_used).total_seconds() > ttl_minutes * 60:
                await self.delete_session(session_id)
                removed += 1
        return removed
