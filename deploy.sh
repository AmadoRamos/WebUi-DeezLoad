#!/usr/bin/env bash
# Instala o actualiza la app en un servidor Linux (Debian/Ubuntu) con PM2.
# Se puede repetir: la primera vez instala todo, después solo actualiza y reinicia.
# Ejecútalo con el mismo usuario con el que corre PM2 (cada usuario tiene su propia lista).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/AmadoRamos/WebUi-DeezLoad/main/deploy.sh)
#   bash /opt/WebUi-DeezLoad/deploy.sh
#
# Variables (opcionales): DIR=/opt/WebUi-DeezLoad  BRANCH=main, y solo al crear el proceso de PM2:
# HOST=0.0.0.0  PORT=8000 (con un proxy delante, como Caddy, usa HOST=127.0.0.1).
set -euo pipefail

REPO=https://github.com/AmadoRamos/WebUi-DeezLoad.git
DIR=${DIR:-/opt/WebUi-DeezLoad}
HOST=${HOST:-0.0.0.0}
PORT=${PORT:-8000}
BRANCH=${BRANCH:-main}
APP=deezload

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
SUDO=; [ "$(id -u)" -eq 0 ] || SUDO=sudo

# 1. Node.js 20 o superior, git y PM2
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  say "Instalando Node.js 22"
  $SUDO apt-get update && $SUDO apt-get install -y curl ca-certificates git
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
  $SUDO apt-get install -y nodejs
fi
command -v git >/dev/null || { $SUDO apt-get update && $SUDO apt-get install -y git; }
command -v pm2 >/dev/null || { say "Instalando PM2"; $SUDO npm install -g pm2; }

# 2. Código
if [ -d "$DIR/.git" ]; then
  say "Actualizando $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH" || die "Hay cambios locales en $DIR que no dejan actualizar (git status)."
else
  say "Descargando en $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

say "Instalando dependencias"
(cd "$DIR/node" && npm ci --no-audit --no-fund)

# 3. Configuración: .env y sesión de Telegram (solo la primera vez)
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
  die "Creé $DIR/.env: rellena TG_API_ID, TG_API_HASH y DOWNLOADS_DIR y vuelve a ejecutar este script."
fi
chmod 600 "$DIR/.env"

session=$(sed -n 's/^NODE_SESSION=//p' "$DIR/.env" | tr -d '\r"' | tail -1)
session=${session:-deezload_node.session}
[[ $session = /* ]] || session="$DIR/node/$session"
if [ ! -f "$session" ]; then
  [ -t 0 ] || die "Falta iniciar sesión en Telegram: ejecuta el script desde una terminal (no con curl | bash)."
  say "Inicio de sesión en Telegram (teléfono y código)"
  pm2 stop "$APP" >/dev/null 2>&1 || true   # la misma sesión no puede usarse en dos sitios
  (cd "$DIR/node" && npm run --silent cli -- login)
fi
chmod 600 "$session"

# 4. PM2: si el proceso ya existe se reinicia con su configuración; si no, se crea
if pm2 describe "$APP" >/dev/null 2>&1; then
  say "Reiniciando $APP"
  pm2 restart "$APP"
else
  conf="$DIR/node/ecosystem.config.cjs"
  if [ ! -f "$conf" ]; then
    cat > "$conf" <<EOF
module.exports = {
  apps: [{
    name: "$APP",
    cwd: "$DIR/node",
    script: "src/web.ts",
    interpreter: "node",
    interpreter_args: "--import tsx",
    args: "--host $HOST --port $PORT",
    exec_mode: "fork",
    instances: 1,          // nunca más de 1: dos procesos hablarían con el bot a la vez
    autorestart: true,
    restart_delay: 10000,
    max_restarts: 10,
    kill_timeout: 5000,
    time: true
  }]
};
EOF
  fi
  say "Creando $APP en PM2"
  pm2 start "$conf"
  pm2 install pm2-logrotate >/dev/null || true
  if [ -z "$SUDO" ]; then pm2 startup systemd >/dev/null; else
    echo "Para que arranque solo al reiniciar el servidor, ejecuta lo que indique:  pm2 startup systemd"; fi
fi
pm2 save >/dev/null

sleep 5
pm2 status "$APP"
pm2 logs "$APP" --lines 10 --nostream
echo
echo "Si arriba no pone «online» o se ve un error, revisa: pm2 logs $APP"
