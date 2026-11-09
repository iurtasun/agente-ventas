#!/usr/bin/env python3
"""Cliente de consola del agente de ventas.

El backend HTTP vive en `app/`; este script reutiliza el mismo agente para
hacer preguntas rápidas desde la terminal.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from app.agent import SalesAgent
from app.config import DEFAULT_MODEL


async def ask_once(agent: SalesAgent, session, prompt: str) -> None:
    async for item in session.stream_turn(prompt):
        if item["event"] == "delta":
            sys.stdout.write(item["data"]["text"])
            sys.stdout.flush()
        elif item["event"] == "tool_start":
            print(f"\n  ⟳ {item['data']['name']}({item['data']['arguments']})", file=sys.stderr)
        elif item["event"] == "error":
            print(f"\nError: {item['data']['message']}", file=sys.stderr)
    print()


async def run(question: str | None, model: str) -> None:
    agent = SalesAgent()
    await agent.start()
    try:
        session = await agent.create_session(model)
        if question:
            await ask_once(agent, session, question)
            return

        print("📊 Agente de ventas. Escribe 'salir' para terminar.")
        while True:
            try:
                prompt = input("Tú: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if prompt.lower() in {"salir", "exit", "quit"}:
                break
            if prompt:
                print("Asistente: ", end="", flush=True)
                await ask_once(agent, session, prompt)
    finally:
        await agent.stop()


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Agente de análisis de ventas (CLI)")
    parser.add_argument("--pregunta", help="Pregunta única, sin abrir el modo interactivo")
    parser.add_argument("--modelo", default=DEFAULT_MODEL, help="Modelo de OpenRouter")
    args = parser.parse_args()
    try:
        asyncio.run(run(args.pregunta, args.modelo))
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
