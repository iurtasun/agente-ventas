# Agente de ventas

Extraído de la sección **Agente simple de ventas** de `original.ipynb`.
Incluye `sales_data.db` (697.894 filas), descargada desde el enlace del notebook.

Hay dos formas de usarlo:

- **Servidor web**: API HTTP + interfaz de chat en el navegador.
- **Consola**: el CLI original, para preguntas rápidas.

Repositorio original: <https://github.com/juananpe/agente-ventas>

## Arranque rápido (sin Docker)

Necesitas Python 3.11 o posterior.

```sh
python -m venv .venv
```

macOS y Linux:

```sh
./.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env        # y pega tu clave en .env
./.venv/bin/python -m uvicorn app.main:app --reload
```

Windows (PowerShell):

```powershell
.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
.venv\Scripts\python -m uvicorn app.main:app --reload
```

Abre <http://127.0.0.1:8000>. Si la clave no está configurada, el indicador de
la esquina inferior izquierda lo avisa en rojo.

## Arranque con el contenedor (opcional)

Solo necesitas [Docker](https://www.docker.com/products/docker-desktop/) y
[Visual Studio Code](https://code.visualstudio.com/) con la extensión
**Dev Containers**.

1. Clona el repositorio y ábrelo en VS Code.
2. `F1` → **Dev Containers: Reopen in Container**.
3. Pega tu clave de OpenRouter en `.env` (se crea desde `.env.example`).
4. En la terminal del contenedor:

```sh
python -m uvicorn app.main:app --host 0.0.0.0 --reload
```

## Uso desde la consola

```sh
./.venv/bin/python agente_ventas.py
```

O una pregunta única:

```sh
./.venv/bin/python agente_ventas.py --pregunta "¿Cuál es el top 5 de tiendas por ventas totales?"
```

En Windows, cambia `./.venv/bin/python` por `.venv\Scripts\python`.

## La API

Todas las sesiones viven en memoria del servidor: cada conversación tiene su
propio contexto y su historial. Se cierran solas tras 60 minutos inactivas.

| Método   | Ruta                            | Descripción                                        |
| -------- | ------------------------------- | -------------------------------------------------- |
| `GET`    | `/api/health`                   | Estado de la configuración y número de sesiones    |
| `GET`    | `/api/sessions`                 | Lista las conversaciones activas                   |
| `POST`   | `/api/sessions`                 | Crea una conversación (`{"model": "..."}` opcional) |
| `GET`    | `/api/sessions/{id}`            | Metadatos e historial completo                     |
| `DELETE` | `/api/sessions/{id}`            | Cierra y descarta la conversación                  |
| `POST`   | `/api/sessions/{id}/messages`   | Envía un turno; responde con un flujo **SSE**      |

El turno devuelve eventos de Server-Sent Events:

```
event: delta
data: {"text": "Voy a consultar..."}

event: tool_start
data: {"id": "...", "name": "query_sales", "arguments": {"sql": "SELECT ..."}}

event: tool_end
data: {"id": "...", "success": true, "result": "...", "error": null}

event: done
data: {"at": "2026-11-09T11:48:25+00:00"}
```

Si ya hay un turno en curso en esa sesión, la petición responde `409`.

## Configuración

Variables de entorno (archivo `.env` o entorno del sistema):

| Variable              | Por defecto                    | Uso                                    |
| --------------------- | ------------------------------ | -------------------------------------- |
| `OPENROUTER_API_KEY`  | —                              | **Obligatoria**. Clave de OpenRouter.  |
| `AGENT_MODEL`         | `deepseek/deepseek-v4.1-flash` | Modelo por defecto.                    |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Endpoint compatible con OpenAI.        |
| `SALES_DB_PATH`       | `sales_data.db`                | Ruta alternativa a la base SQLite.     |
| `SESSION_TTL_MINUTES` | `60`                           | Inactividad tras la que se cierra una sesión. |
| `TURN_TIMEOUT_SECONDS`| `180`                          | Espera máxima por respuesta del modelo. |

## Estructura

```
app/
  config.py     Variables de entorno y rutas
  tools.py      La herramienta query_sales (SQL de solo lectura)
  agent.py      Envoltorio del SDK: cliente compartido y sesiones
  main.py       API FastAPI y servido del frontend
static/
  index.html    Interfaz de chat
  styles.css    Estilos (tema claro y oscuro)
  app.js        Cliente vanilla JS con streaming SSE
agente_ventas.py  CLI que reutiliza app.agent
sales_data.db     Datos de ventas
```

## Seguridad

La base SQLite se abre en modo de solo lectura (`mode=ro` + `PRAGMA query_only=ON`)
y la herramienta rechaza cualquier sentencia que no empiece por `SELECT`.
Cada consulta devuelve como máximo 100 filas.
