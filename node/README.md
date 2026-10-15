# deezload en Node.js

Conversación con @deezload2bot en TypeScript con [GramJS](https://gram.js.org) (paquete `telegram`).

- **Bot:** conexión, búsqueda del artista, lista de álbumes con sus páginas, abrir
  álbumes, leer canciones, recorrer la discografía y pedir las pistas (GET ALL).
- **Descargas:** carpeta de `DOWNLOADS_DIR`, `ajustes.json` (cuántas a la vez), las canciones
  que ya tienes se saltan aunque el nombre cambie (tildes, ñ, "(Album Version)", signos), cada pista
  se baja a `.part` y se renombra al terminar, y una pista que falla no detiene las demás.
- **Servidor web:** la interfaz de `webui/` (búsqueda, carátulas y datos de Deezer, descargas,
  reintentos, discografías, avisos en vivo).

## Servidor web

```
npm run web                                   (o doble clic en web.bat)
npm run web -- --host 0.0.0.0 --port 8080
```

Abre http://127.0.0.1:8000. Usa la interfaz de `webui/index.html`, la carpeta de descargas,
`ajustes.json` y `DISC_PAUSE` del `.env`.
No abras dos servidores a la vez: hablarían con el bot al mismo tiempo (si el puerto 8000
ya está en uso, avisa y no arranca). Ctrl+C lo cierra al instante.

**Varios artistas con ese nombre:** si solo uno se llama exactamente como lo escribiste (sin
distinguir mayúsculas ni tildes), se usa ese aunque no sea el primero del bot. Si no (por ejemplo
«soda», o un nombre mal escrito), la web muestra los artistas que encontró el bot, con sus álbumes
y seguidores, para que elijas. Es solo una consulta al bot: no envía nada al chat.

## Buscar una canción

En la web, elige «Canción» encima del buscador y escribe el título (y el artista, si quieres
acotar). Sale la lista de canciones que encuentra el bot, de cualquier artista, con su artista y
álbum; las que ya tienes en tu carpeta aparecen como «Ya la tienes». Buscar es solo una consulta
al bot: no envía nada al chat.

«Descargar» elige esa canción en el bot, que envía su archivo directamente (unos 8 s), y se baja
como cualquier descarga: avance en la bandeja, «ya estaba» si la tienes y reintento si falla.
Solo se muestran las canciones de la primera página de resultados del bot (unas 25).

**Una canción de un álbum:** en la ficha del álbum, cada canción tiene un botón ↓ para bajar solo
esa (las que ya tienes no lo muestran). Se busca igual, por título y artista, y se elige la versión
de ese álbum; si el bot no la tiene en ese álbum y hay varias versiones, avisa en lugar de bajar otra.

**Versión explícita o limpia:** en **⚙ Ajustes** (arriba, junto al logo), «Si hay versión explícita y limpia,
quedarse con: Explícita / Limpia / La que tenga» (se guarda en `ajustes.json` como `version`). Las
dos versiones se guardan con el mismo nombre; cuál tienes se sabe por la etiqueta `ITUNESADVISORY`
que el bot escribe en el FLAC (1 explícita, 0 limpia). Si tienes la otra versión, al descargar se
baja la que llega y, si es la que quieres, **sobrescribe** el archivo; si llega otra vez la misma
versión, se descarta. Solo cuenta como «ya la tienes» la versión que quieres. Si un archivo no es
FLAC o no tiene la etiqueta, no se sabe su versión y nunca se sustituye. «La que tenga» (por
defecto) es como antes: la que tengas vale.

El nombre del álbum también cuenta: la lista de álbumes del bot marca los explícitos con 🅴
(«STANS (The Official Soundtrack) 🅴» frente a «STANS (The Official Soundtrack)»). Si el álbum es
de la otra versión, no puede traer la que quieres y no se baja nada de él que ya tengas. En una
discografía, si eliges las dos versiones de un álbum, solo se descarga la que prefieres (la tarjeta
dice cuál se omite). La búsqueda directa del bot no marca el 🅴 (devuelve dos «STANS (The Official
Soundtrack)» iguales): con un álbum abierto así no se sabe su versión, y se baja y se mira la
etiqueta de cada canción. Ojo: la versión limpia a veces trae el título censurado («Just Don't Give
a F\*\*» frente a «Just Don't Give A Fuck»); con nombres distintos no se reconocen como la misma
canción y se guardan las dos.

**Álbumes que ya tienes en parte:** al descargar un álbum (o una discografía), si ya tienes algunas
de sus canciones y faltan como mucho 10 (se cambia en ⚙ Ajustes; por defecto `UNA_A_UNA_MAX`), se piden una a una solo
las que faltan, en lugar de GET ALL (que hace al bot enviar el álbum entero). Si ya las tienes
todas, no se le pide nada al bot. Si faltan más de 10, o no se puede pedirlas una a una (la ficha
no muestra todas las canciones, una no se encuentra…), se usa GET ALL como siempre y lo que ya
tienes se salta al bajar. La tarjeta de la descarga va diciendo cuál pide («1 de 3 que faltan»).
En `logs\bot.log` queda cuánto tardó cada canción y cada GET ALL, para ajustar ese número.

## Búsqueda directa de álbum

Para abrir un álbum hacía falta buscar al artista, pulsar ALBUMS y recorrer todas las páginas de la
lista (unos 20 s por página: con 70 álbumes, casi 2 minutos). Ahora se busca «álbum artista» en el
modo inline del bot (sin el prefijo `.art`), que además de canciones devuelve álbumes
(«Éxitos (Album)», con el artista debajo). Al elegirlo, el bot abre la ficha del álbum al momento
(unos 12 s).

- **En la web**: escribe el artista y, en el segundo campo, el álbum. Se abre su ficha con las
  canciones y «Descargar álbum». «Ver todos sus álbumes» carga la lista completa como antes.
  Si dejas el álbum vacío, todo funciona como siempre.
- **Solo el álbum, sin artista**: deja el artista vacío y escribe el álbum. Sale la lista de álbumes
  con ese título que encuentra el bot, de cualquier artista; al elegir uno se abre su ficha como
  arriba. Buscar es solo una consulta al bot: no envía nada al chat.
- **Sin cambiar nada**: abrir un álbum desde la lista o descargarlo también usa la búsqueda
  directa (`/api/tracks`, `/api/download`, `npm run cli -- tracks` y `download`). En la web usa el
  nombre del artista que da el bot, aunque lo hayas escrito distinto.
- **Discografías**: cada álbum se abre con la búsqueda directa (sin BACK ni pasar páginas); la
  lista de álbumes solo se abre para los que no se encuentran así.
- **Cuándo se usa**: solo si hay un único álbum con ese título y ese artista. Primero busca el
  título exacto; si no lo hay, sin distinguir tildes («exitos» → «Éxitos»). Los símbolos sí
  cuentan («Imparable 🅴» no es «Imparable»).
- **Si no sirve** (el nombre del artista no coincide, hay dos álbumes iguales, el título viene
  recortado, el bot abre otra cosa…), se usa la lista de álbumes de siempre: funciona, pero tarda
  lo de antes.
- En la línea de comandos, si eliges otro artista (`n` > 0) se usa la lista: el nombre escrito no
  distingue a qué artista se refiere. En la web se usa el nombre que dio el bot, así que la búsqueda
  directa vale también para el artista elegido.

En `logs\bot.log` aparece como `busca directo «…» -> «… (Album)»`, o cuántas coincidencias hubo
cuando se usó la lista.

## Instalar

1. Node.js 20 o superior (https://nodejs.org, versión LTS).
2. Doble clic en `setup.bat` (instala las dependencias).
3. Doble clic en `login.bat`: pide tu teléfono y el código que te llega a Telegram.
   Crea `deezload_node.session` en esta carpeta (`node`). No la uses en otro programa a la vez:
   Telegram puede invalidarla. Trátala como una contraseña.

Usa el `.env` de la carpeta de arriba (`TG_API_ID`, `TG_API_HASH`, `DEEZ_BOT`, tiempos…).

## Probar

```
npm run cli -- albums "Soda Stereo"
npm run cli -- tracks "Soda Stereo" "SEP7IMO DIA"
npm run cli -- getall "Soda Stereo" "SEP7IMO DIA"     (pide las pistas, no las descarga)
npm run cli -- download "Soda Stereo" "SEP7IMO DIA"   (descarga el álbum)
```

`descargar.bat "Artista" "Álbum"` hace lo mismo con doble clic desde una consola. Muestra el
avance de cada pista y, al final, cuáles se bajaron, cuáles ya estaban y cuáles fallaron.
La carpeta es la de `DOWNLOADS_DIR` en `.env` (por defecto `downloads`, en la carpeta de arriba).

No tengas abierto el servidor web mientras descargas desde la consola: los dos hablarían con el
bot a la vez.

## Si el bot tarda o responde otra cosa

Antes de dar un error, intenta arreglarlo sola y lo va contando en la interfaz:

- **Reconoce qué está mostrando el bot**: la ficha del artista (TOP 30, ALBUMS…), la lista de
  álbumes, la ficha de un álbum o un archivo.
- **Si el bot tarda**, espera (hasta `SLOW_WAIT` s, 15 por defecto) y avisa "El bot está
  tardando en responder…". Si no reaccionó nada, vuelve a pulsar el botón (hasta `BOT_RETRIES`
  veces). Solo vuelve a pulsar cuando nada cambió, para no saltarse páginas.
- **Si responde otra cosa**, se recupera:
  - esperaba la lista y llegó la ficha del artista → pulsa ALBUMS;
  - esperaba la lista y llegaron las canciones de un álbum → BACK;
  - abrió otro álbum → vuelve a la lista y abre el correcto;
  - BACK llevó a la ficha del artista → ALBUMS.
- **Lista completa**: con el contador del bot ("2/5"), si una página no carga insiste, y si
  se saltó alguna vuelve atrás a buscarla.
- **Búsqueda**: si no aparece la ficha del artista, busca otra vez. Si algo falla a mitad de
  camino, empieza la operación de nuevo (hasta `BOT_RETRIES` veces).
- **GET ALL**: si no llega ningún archivo, lo pide otra vez (`GETALL_RETRIES`). Si el bot
  manda archivos repetidos, cuenta cada pista una vez.
- **Telegram**: cortes de red y servidores ocupados se reintentan solos; si Telegram pide
  esperar (FLOOD_WAIT), espera hasta `FLOOD_MAX_WAIT` s. Una descarga cortada se repite desde cero.

Si el bot no reacciona ni insistiendo, el error sale en menos de un minuto (3 pulsaciones de
15 s), sin volver a empezar.

## Pruebas automáticas (sin Telegram)

```
npm test
```

202 pruebas: lista paginada en los dos modos del bot y 4 estilos de flechas, álbumes con
nombres engañosos ("Quiero Más", "Back in Black"), discografía con BACK, espera tras GET ALL,
traducción de mensajes de GramJS y las peticiones que se envían a Telegram.
Descargas en secuencia y hasta 5 a la vez (con cambio en caliente y orden por álbum),
pistas que fallan, descargas cortadas que no dejan `.part`, reintentos, ajustes, canciones
que ya estaban, y las claves de 205 nombres reales de tu carpeta.
Servidor web: todas las rutas, avisos en vivo (SSE: estado inicial, solo cambios, ping, cierre),
discografías (orden estricto, pausa, cancelar, reintento al final, lista perdida) y carátulas.
Respaldos (bot falso con fallos inyectados, en sus dos modos): bot lento, botones que no
responden, la ficha del artista en lugar de la lista, otro álbum, páginas saltadas, GET ALL
sin respuesta o con archivos repetidos, cortes de red y FLOOD_WAIT.
Descargas con el permiso del archivo caducado (FILE_REFERENCE_EXPIRED): se vuelve a pedir el
mensaje al chat y se repite la descarga una vez.
Búsqueda directa de álbum: elige el del artista pedido (no otro con el mismo título), no toca la
lista y acepta el título sin tildes.

`npx tsx test/support/serve-stub.ts 8772 <carpeta> <ajustes.json> ../webui` arranca el servidor
con un bot de mentira (sin Telegram), útil para probar la interfaz.
