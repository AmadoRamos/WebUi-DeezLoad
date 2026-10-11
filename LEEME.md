# deezload

Puente con el bot de Telegram @deezload2bot para explorar artistas y descargar álbumes,
con interfaz web y servidor MCP para Claude. Hay dos versiones que hacen lo mismo:

| Carpeta   | Versión                                    | Servidor web          | Sesión de Telegram            |
|-----------|--------------------------------------------|-----------------------|-------------------------------|
| `python\` | Original (Telethon + FastAPI), con MCP     | `python\run_web.bat`  | `python\deezload.session`     |
| `node\`   | Nueva (GramJS + Node.js), sin MCP todavía  | `node\web.bat`        | `node\deezload_node.session`  |

Las dos usan lo que está en esta carpeta:

- `.env`: credenciales y tiempos (plantilla en `env.example`).
- `downloads\`: la música. Las canciones que ya están aquí no se vuelven a bajar.
- `ajustes.json`: cuántas descargas a la vez.
- `webui\`: la interfaz web.

**No abras las dos versiones a la vez**: hablarían con el bot al mismo tiempo. Las dos usan el
puerto 8000; la de Node avisa si está ocupado.

## Python

1. `python\setup_venv.bat` (la primera vez: crea el entorno e inicia sesión en Telegram).
2. `python\run_web.bat` y abre http://127.0.0.1:8000.

MCP en Claude Desktop (`claude_desktop_config.json`):

```json
"deezload": {
  "command": "D:\\musica\\telegram_mcp\\python\\.venv\\Scripts\\python.exe",
  "args": ["D:\\musica\\telegram_mcp\\python\\deezload_mcp.py"]
}
```

## Node.js

Ver `node\README.md`: `setup.bat`, `login.bat` (la primera vez) y `web.bat`.
