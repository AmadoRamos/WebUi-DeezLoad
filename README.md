# WebUi-DeezLoad

Interfaz web (Node.js) para explorar artistas y descargar álbumes a través del bot de Telegram
[@deezload2bot](https://t.me/deezload2bot). El proyecto habla con el bot usando **tu propia cuenta de
Telegram** (no es un bot): busca al artista, recorre su lista de álbumes, abre cada álbum, pide las
pistas (GET ALL) y descarga los archivos a una carpeta.

- **Interfaz web**: búsqueda de artistas, carátulas y datos de Deezer, descargas en paralelo con avance
  en vivo, reintentos y descarga de discografías completas (con pausa, reanudar y cancelar).
- **Búsqueda directa de álbum**: escribe artista y álbum y se abre al momento, sin recorrer la lista
  de álbumes del artista (con muchos álbumes, de ~2 min a ~12 s).
- **Búsqueda por título**: álbumes sin saber el artista y canciones sueltas.
- **Sin duplicados**: las canciones que ya están en la carpeta no se vuelven a bajar, aunque el nombre
  cambie (tildes, ñ, "(Album Version)", signos).
- **Resistente a un bot lento**: reconoce qué está mostrando el bot y se recupera solo cuando tarda o
  responde otra cosa.

> Proyecto personal. Úsalo solo con música que tengas derecho a descargar.

## Estructura

```
.
├── .env            credenciales y tiempos (se crea a partir de env.example; no se sube)
├── env.example     plantilla del .env
├── ajustes.json    ajustes de la interfaz (descargas a la vez, versión, pausas…)
├── downloads/      la música (no se sube)
├── webui/          la interfaz web (index.html)
└── node/           servidor y bot en Node.js + GramJS (detalles en node/README.md)
```

**No abras dos copias a la vez**: hablarían con el bot al mismo tiempo. El servidor usa el puerto
8000 y avisa si está ocupado.

## Configuración

1. Consigue tu `api_id` y `api_hash` en <https://my.telegram.org> → *API development tools*.
2. Copia `env.example` como `.env` **en la raíz del repo** y rellena al menos:

| Variable         | Para qué sirve                                                        | Por defecto       |
|------------------|-----------------------------------------------------------------------|-------------------|
| `TG_API_ID`      | API id de Telegram                                                    | —                 |
| `TG_API_HASH`    | API hash de Telegram                                                  | —                 |
| `DEEZ_BOT`       | Bot con el que se habla                                               | `deezload2bot`    |
| `DOWNLOADS_DIR`  | Carpeta de descargas (relativa a la raíz si no es absoluta)           | `downloads`       |
| `NODE_SESSION`   | Archivo de sesión de Telegram (en `node/`)                            | `deezload_node.session` |
| `DISC_PAUSE`     | Segundos de pausa entre álbumes de una discografía                    | `5`               |

El resto de tiempos y reintentos (`QUIET_SECONDS`, `MAX_WAIT`, `FILES_WAIT`, `BOT_RETRIES`,
`SLOW_WAIT`, `FLOOD_MAX_WAIT`…) están explicados en `env.example`.

`ajustes.json` guarda los ajustes de **⚙ Ajustes** (arriba, junto al logo), que se cambian desde la
interfaz y se aplican al momento: cuántas descargas a la vez, con qué versión
quedarse si una canción es explícita y limpia (`explicita`, `limpia` o `cualquiera`), hasta cuántas
canciones que faltan se piden una a una (`una_a_una_max`; por defecto `UNA_A_UNA_MAX`) y la pausa entre
álbumes de una discografía (`pausa_discografia`; por defecto `DISC_PAUSE`):

```json
{ "descargas_simultaneas": 5, "version": "cualquiera", "una_a_una_max": 10, "pausa_discografia": 5 }
```

En el mismo menú se activan los avisos del sistema (Windows, macOS…) al terminar una descarga, con la
página en segundo plano. Eso se guarda en el navegador, no en `ajustes.json`, y solo funciona abriendo
la página en el propio equipo (`http://127.0.0.1:8000`) o con https.

El menú muestra además el bot y la carpeta de descargas (solo lectura: se cambia con `DOWNLOADS_DIR`
en el `.env`). El punto del botón **⚙ Ajustes** indica si la página llega al servidor: verde si responde,
rojo si no.

> **Seguridad**: el `.env` y los archivos `*.session` dan acceso a tu cuenta de Telegram. Trátalos
> como contraseñas; ya están en `.gitignore`. No uses la misma sesión en dos programas a la vez:
> Telegram puede invalidarla.

## Uso en Windows

1. Instala Node.js 20 o superior (LTS) desde <https://nodejs.org>.
2. `node\setup.bat` — instala las dependencias.
3. `node\login.bat` — la primera vez: pide tu teléfono y el código que te llega a Telegram.
4. `node\web.bat` y abre <http://127.0.0.1:8000>.

Línea de comandos (desde `node/`):

```
npm run cli -- albums "Soda Stereo"
npm run cli -- tracks "Soda Stereo" "SEP7IMO DIA"
npm run cli -- download "Soda Stereo" "SEP7IMO DIA"
npm run web -- --host 0.0.0.0 --port 8080
npm test                      # pruebas automáticas, sin Telegram
```

## Despliegue en un servidor Linux

Probado con Debian/Ubuntu (por ejemplo, un contenedor LXC en Proxmox). Los comandos están escritos
para `root`; con otro usuario, antepón `sudo`.

> **Importante**: la interfaz web **no pide usuario ni contraseña**. Quien llegue a ella puede usar tu
> cuenta de Telegram. Úsala solo en tu red local (sin abrir el puerto en el router), por una VPN como
> Tailscale o detrás de un proxy con contraseña (ver más abajo).

### 1. Node.js y el código

```bash
apt update && apt install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

git clone https://github.com/AmadoRamos/WebUi-DeezLoad.git /opt/WebUi-DeezLoad
cd /opt/WebUi-DeezLoad/node
npm ci            # incluye tsx, que hace falta para ejecutar (no hay paso de compilación)
```

### 2. Configuración e inicio de sesión

```bash
cd /opt/WebUi-DeezLoad
cp env.example .env
nano .env                         # TG_API_ID, TG_API_HASH y DOWNLOADS_DIR=/ruta/a/tu/musica
chmod 600 .env

cd node
npm run cli -- login              # una sola vez: teléfono y código de Telegram
chmod 600 deezload_node.session
```

Si en el mismo servidor tienes Navidrome u otro reproductor, apunta `DOWNLOADS_DIR` a su carpeta de
música y lo descargado aparecerá directamente en tu biblioteca.

Prueba a mano: `node --import tsx src/web.ts --host 127.0.0.1 --port 8000` (Ctrl+C para cerrar).

### 3a. Dejarlo corriendo con PM2

```bash
npm install -g pm2
```

Crea `node/ecosystem.config.cjs` (tiene que ser `.cjs` porque el paquete es `"type": "module"`):

```js
module.exports = {
  apps: [{
    name: "deezload",
    cwd: "/opt/WebUi-DeezLoad/node",
    script: "src/web.ts",
    interpreter: "node",
    interpreter_args: "--import tsx",
    args: "--host 0.0.0.0 --port 8000",   // 127.0.0.1 si va detrás de un proxy
    exec_mode: "fork",
    instances: 1,          // nunca más de 1: dos procesos hablarían con el bot a la vez
    autorestart: true,
    restart_delay: 10000,
    max_restarts: 10,
    kill_timeout: 5000,
    time: true
  }]
};
```

```bash
cd /opt/WebUi-DeezLoad/node
pm2 start ecosystem.config.cjs
pm2 startup systemd      # arranque automático al reiniciar el servidor
pm2 save
pm2 install pm2-logrotate

pm2 logs deezload        # ver logs
pm2 restart deezload     # reiniciar
```

### 3b. O con systemd (sin PM2)

`/etc/systemd/system/deezload.service`:

```ini
[Unit]
Description=deezload web (Node)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/WebUi-DeezLoad/node
ExecStart=/usr/bin/node --import tsx src/web.ts --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now deezload
journalctl -u deezload -f
```

Usa PM2 **o** systemd, no los dos a la vez.

### 4. Acceso desde fuera con contraseña (opcional)

Con un dominio propio, [Caddy](https://caddyserver.com) pone HTTPS automático y pide contraseña
(genera el hash con `caddy hash-password`). Maneja bien los avisos en vivo (SSE) sin configuración extra.
En este caso arranca el servidor con `--host 127.0.0.1`.

```
musica.tudominio.com {
    basic_auth {
        amado <hash>
    }
    reverse_proxy 127.0.0.1:8000
}
```

### 5. Actualizar

```bash
cd /opt/WebUi-DeezLoad && git pull && cd node && npm ci
pm2 restart deezload          # o: systemctl restart deezload
```

### Logs y problemas comunes

- Conversación con el bot: `node/logs/bot.log` (`BOT_TRACE=0` en el `.env` lo desactiva).
- `npm: command not found`: falta instalar Node.js (paso 1).
- `El puerto 8000 ya está en uso`: ya hay otra copia corriendo (PM2, systemd o `web.bat`).
- Si Telegram cierra la sesión: detén el servicio, vuelve a ejecutar `npm run cli -- login` y arráncalo de nuevo.
