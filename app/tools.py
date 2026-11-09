"""Herramienta SQL de solo lectura que el agente puede invocar."""

from __future__ import annotations

import re
import sqlite3

from copilot.tools import define_tool
from pydantic import BaseModel, Field

from .config import DB_PATH

MAX_ROWS = 100


class QuerySalesParams(BaseModel):
    sql: str = Field(description="Consulta SQL SELECT de solo lectura a la tabla sales")


@define_tool(description="Ejecuta una consulta SELECT de solo lectura sobre las ventas")
async def query_sales(params: QuerySalesParams) -> dict:
    sql = params.sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^SELECT\b", sql):
        return {"error": "Solo se permiten consultas SELECT"}
    try:
        connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        try:
            cursor = connection.execute(sql)
            rows = [dict(row) for row in cursor.fetchmany(MAX_ROWS + 1)]
        finally:
            connection.close()
    except sqlite3.Error as exc:
        return {"error": str(exc)}

    truncated = len(rows) > MAX_ROWS
    rows = rows[:MAX_ROWS]
    return {"rows": rows, "count": len(rows), "truncated": truncated}
