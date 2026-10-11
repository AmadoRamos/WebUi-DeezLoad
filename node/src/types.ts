/** Formas de datos comunes. Siguen las de la versión en Python para que la API no cambie. */

export type ButtonKind = "callback" | "switch_inline" | "url" | "other";

export interface Button {
  text: string;
  kind: ButtonKind;
  data?: Buffer;          // callback
  query?: string;         // switch_inline
  url?: string;
}

export interface DocInfo {
  kind: "document";
  mime?: string;
  size: number;
  file_name?: string;
  audio?: boolean;
  title?: string;
  performer?: string;
  duration?: number;
  video?: boolean;
}

export type MediaInfo = DocInfo | { kind: string };

/** Un mensaje del chat con el bot, ya traducido desde Telegram. */
export interface Msg {
  id: number;
  text: string;
  buttons: Button[][];
  out: boolean;           // lo envió esta cuenta
  viaBot: boolean;        // enviado "vía @bot" (resultado inline)
  editDate: number;
  media?: MediaInfo;
  hasDocument: boolean;
  raw?: unknown;          // el mensaje original de GramJS (para descargarlo en la fase 2)
}

/** Lo que se devuelve hacia fuera (CLI, web, MCP): igual que `snapshot` en Python. */
export interface Snapshot {
  message_id: number;
  text: string;
  buttons: { text: string; kind: ButtonKind; inline_query?: string; url?: string }[][];
  media?: MediaInfo;
}

export interface InlineResult { id: string; title?: string; description?: string; type?: string; url?: string }

/** Todo lo que la lógica necesita de Telegram. GramJS lo implementa; las pruebas usan un bot falso. */
export interface Transport {
  /** Mensajes por id (undefined si no existe), en el mismo orden. */
  getMessages(ids: number[]): Promise<(Msg | undefined)[]>;
  /** Los mensajes más recientes con id > minId (como mucho `limit`). */
  getSince(minId: number, limit: number): Promise<Msg[]>;
  lastId(): Promise<number>;
  /** Pulsa un botón de callback del mensaje `msgId`. */
  pressButton(msgId: number, button: Button): Promise<void>;
  inlineQuery(query: string, offset?: string): Promise<{ queryId: unknown; results: InlineResult[]; nextOffset?: string }>;
  sendInlineResult(queryId: unknown, resultId: string): Promise<void>;
  sendMessage(text: string): Promise<Msg>;
  /** Baja el archivo del mensaje a `path`. Cuando termina, el archivo ya está cerrado y completo. */
  download(msg: Msg, path: string, onProgress?: (received: number, total: number) => void): Promise<void>;
}
