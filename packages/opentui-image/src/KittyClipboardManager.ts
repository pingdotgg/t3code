import * as NodeBuffer from "node:buffer";
import * as NodeTimers from "node:timers";

import { CliRenderEvents, type CliRenderer } from "@opentui/core";

import { encodeKittyCommand, type KittyProtocolTransport } from "./kittyProtocol.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const ENABLE_PASTE_EVENTS = `${ESC}[?5522h`;
const DISABLE_PASTE_EVENTS = `${ESC}[?5522l`;
const PASTE_EVENT_NAME = NodeBuffer.Buffer.from("Paste event").toString("base64");
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

const PREFERRED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/avif",
  "image/svg+xml",
] as const;

export interface KittyClipboardWriter {
  write(chunk: string): unknown;
}

export interface KittyClipboardExtensionOptions {
  /** Enable DCS passthrough after the host identified a Kitty-capable outer terminal. */
  readonly tmuxPassthrough?: boolean;
  /** Defaults to `process.stdout`. Required for renderers using a custom stream. */
  readonly writer?: KittyClipboardWriter;
  readonly timeoutMs?: number;
}

export interface KittyClipboardActivationOptions {
  readonly maxBytes?: number;
  readonly onError?: (error: Error) => void;
}

interface ParsedPacket {
  readonly fields: ReadonlyMap<string, string>;
  readonly payload?: string;
}

interface PasteListing {
  readonly mimeTypes: string[];
  readonly location: string | null;
  readonly password: { readonly key: "pw" | "password"; readonly value: string } | null;
}

interface ClipboardRead {
  readonly mimeType: string;
  readonly chunks: Uint8Array[];
  byteLength: number;
  discarded: boolean;
}

const managers = new WeakMap<CliRenderer, KittyClipboardManager>();

function decodeBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(value)) return null;
  const decoded = NodeBuffer.Buffer.from(value, "base64");
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

function decodeBase64Text(value: string): string | null {
  const decoded = decodeBase64(value);
  if (!decoded) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return null;
  }
}

function isNonEmptyBase64(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && decodeBase64(value) !== null;
}

export function parseKittyClipboardPacket(sequence: string): ParsedPacket | null {
  if (!sequence.startsWith(`${ESC}]5522;`)) return null;
  let body: string;
  if (sequence.endsWith(ST)) body = sequence.slice(`${ESC}]5522;`.length, -ST.length);
  else if (sequence.endsWith("\x07")) body = sequence.slice(`${ESC}]5522;`.length, -1);
  else return null;

  const separator = body.indexOf(";");
  const metadata = separator === -1 ? body : body.slice(0, separator);
  const payload = separator === -1 ? undefined : body.slice(separator + 1);
  const fields = new Map<string, string>();
  for (const item of metadata.split(":")) {
    const equals = item.indexOf("=");
    if (equals <= 0) continue;
    fields.set(item.slice(0, equals).trim(), item.slice(equals + 1).trim());
  }
  if (fields.get("type") !== "read") return null;
  return payload === undefined ? { fields } : { fields, payload };
}

function baseMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function chooseMimeType(mimeTypes: ReadonlyArray<string>): string | null {
  const byBase = new Map(mimeTypes.map((mimeType) => [baseMimeType(mimeType), mimeType]));
  for (const preferred of PREFERRED_MIME_TYPES) {
    const match = byBase.get(preferred);
    if (match) return match;
  }
  for (const mimeType of mimeTypes) {
    if (baseMimeType(mimeType) === "text/plain") return mimeType;
  }
  return null;
}

function concatChunks(chunks: ReadonlyArray<Uint8Array>, byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export class KittyClipboardManager {
  readonly #renderer: CliRenderer;
  #writer: KittyClipboardWriter;
  #writerEnabled: boolean;
  #tmuxPassthrough: boolean;
  #timeoutMs: number;
  readonly #activations = new Map<symbol, KittyClipboardActivationOptions>();
  #listing: PasteListing | null = null;
  #read: ClipboardRead | null = null;
  #timeout: ReturnType<typeof NodeTimers.setTimeout> | null = null;
  #disposed = false;
  readonly #unsubscribeOsc: () => void;

  readonly #onDestroy = (): void => {
    this.dispose();
  };

  constructor(renderer: CliRenderer, options: KittyClipboardExtensionOptions = {}) {
    this.#renderer = renderer;
    this.#writer = options.writer ?? process.stdout;
    this.#writerEnabled = options.writer !== undefined || process.stdout.isTTY === true;
    this.#tmuxPassthrough = options.tmuxPassthrough ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#unsubscribeOsc = renderer.subscribeOsc((sequence) => this.#handleSequence(sequence));
    renderer.on(CliRenderEvents.DESTROY, this.#onDestroy);
  }

  get isDisposed(): boolean {
    return this.#disposed;
  }

  configure(options: KittyClipboardExtensionOptions): void {
    if (this.#disposed) return;
    if (options.writer !== undefined) {
      this.#writer = options.writer;
      this.#writerEnabled = true;
    }
    if (options.tmuxPassthrough !== undefined) this.#tmuxPassthrough = options.tmuxPassthrough;
    if (options.timeoutMs !== undefined) this.#timeoutMs = options.timeoutMs;
  }

  activate(options: KittyClipboardActivationOptions = {}): () => void {
    if (this.#disposed) return () => {};
    const token = Symbol("kitty-clipboard-activation");
    const wasInactive = this.#activations.size === 0;
    this.#activations.set(token, options);
    if (wasInactive) this.#writeControl(ENABLE_PASTE_EVENTS);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#activations.delete(token);
      if (this.#activations.size === 0) {
        this.#reset();
        this.#writeControl(DISABLE_PASTE_EVENTS);
      }
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#activations.size > 0) this.#writeControl(DISABLE_PASTE_EVENTS);
    this.#activations.clear();
    this.#reset();
    this.#unsubscribeOsc();
    this.#renderer.off(CliRenderEvents.DESTROY, this.#onDestroy);
    this.#disposed = true;
    managers.delete(this.#renderer);
  }

  #transport(): KittyProtocolTransport {
    return this.#tmuxPassthrough && this.#renderer.capabilities?.multiplexer === "tmux"
      ? "tmux"
      : "direct";
  }

  #writeControl(sequence: string): void {
    if (!this.#writerEnabled) return;
    this.#writer.write(encodeKittyCommand(sequence, this.#transport()));
  }

  #maximumBytes(): number {
    let maximum = DEFAULT_MAX_BYTES;
    for (const activation of this.#activations.values()) {
      if (activation.maxBytes !== undefined) maximum = Math.min(maximum, activation.maxBytes);
    }
    return maximum;
  }

  #reportError(message: string): void {
    const error = new Error(message);
    for (const activation of this.#activations.values()) activation.onError?.(error);
  }

  #startTimeout(): void {
    if (this.#timeout) NodeTimers.clearTimeout(this.#timeout);
    // @effect-diagnostics-next-line globalTimers:off - Renderer extension lifecycle is callback-based, outside an Effect runtime.
    this.#timeout = NodeTimers.setTimeout(() => {
      this.#timeout = null;
      this.#reset();
      this.#reportError("Clipboard image paste timed out.");
    }, this.#timeoutMs);
    this.#timeout.unref?.();
  }

  #reset(): void {
    if (this.#timeout) NodeTimers.clearTimeout(this.#timeout);
    this.#timeout = null;
    this.#listing = null;
    this.#read = null;
  }

  #handleSequence(sequence: string): void {
    if (this.#disposed || this.#activations.size === 0) return;
    const packet = parseKittyClipboardPacket(sequence);
    if (!packet) return;
    const status = packet.fields.get("status");

    if (!this.#listing && !this.#read && status === "OK") {
      const pw = packet.fields.get("pw");
      const password = packet.fields.get("password");
      this.#listing = {
        mimeTypes: [],
        location: packet.fields.get("loc") === "primary" ? "primary" : null,
        password: isNonEmptyBase64(pw)
          ? { key: "pw", value: pw }
          : isNonEmptyBase64(password)
            ? { key: "password", value: password }
            : null,
      };
      this.#startTimeout();
      return;
    }

    if (status?.startsWith("E")) {
      this.#reset();
      this.#reportError(`Terminal clipboard read failed (${status}).`);
      return;
    }

    if (this.#listing) {
      if (status === "DATA") {
        const encodedMimeType = packet.fields.get("mime");
        const mimeType = encodedMimeType ? decodeBase64Text(encodedMimeType) : null;
        if (mimeType) this.#listing.mimeTypes.push(mimeType);
        return;
      }
      if (status === "DONE") {
        const listing = this.#listing;
        this.#listing = null;
        const mimeType = chooseMimeType(listing.mimeTypes);
        if (!mimeType) {
          this.#reset();
          this.#reportError("The clipboard does not contain a supported image or plain text.");
          return;
        }
        this.#read = { mimeType, chunks: [], byteLength: 0, discarded: false };
        this.#sendReadRequest(mimeType, listing);
        this.#startTimeout();
      }
      return;
    }

    if (!this.#read) return;
    if (status === "OK") {
      this.#startTimeout();
      return;
    }
    if (status === "DATA" && packet.payload !== undefined) {
      const encodedMimeType = packet.fields.get("mime");
      const responseMimeType = encodedMimeType ? decodeBase64Text(encodedMimeType) : null;
      if (
        responseMimeType !== null &&
        baseMimeType(responseMimeType) !== baseMimeType(this.#read.mimeType)
      ) {
        this.#read.discarded = true;
        this.#read.chunks.length = 0;
        this.#reportError("Terminal returned an unexpected clipboard data type.");
        return;
      }
      const chunk = decodeBase64(packet.payload);
      if (!chunk) {
        this.#read.discarded = true;
        this.#reportError("Clipboard image data is not valid base64.");
        return;
      }
      const nextByteLength = this.#read.byteLength + chunk.byteLength;
      if (nextByteLength > this.#maximumBytes()) {
        if (!this.#read.discarded) {
          this.#reportError("Clipboard image exceeds the 10MB attachment limit.");
        }
        this.#read.discarded = true;
        this.#read.chunks.length = 0;
        return;
      }
      if (!this.#read.discarded) {
        this.#read.chunks.push(chunk);
        this.#read.byteLength = nextByteLength;
      }
      this.#startTimeout();
      return;
    }
    if (status === "DONE") {
      const read = this.#read;
      this.#reset();
      if (read.discarded) return;
      const bytes = concatChunks(read.chunks, read.byteLength);
      this.#renderer.keyInput.processPaste(bytes, {
        mimeType: read.mimeType,
        kind: baseMimeType(read.mimeType).startsWith("image/") ? "binary" : "text",
      });
      return;
    }
  }

  #sendReadRequest(mimeType: string, listing: PasteListing): void {
    const encodedMimeType = NodeBuffer.Buffer.from(mimeType).toString("base64");
    const location = listing.location ? `:loc=${listing.location}` : "";
    if (listing.password) {
      const password = `:${listing.password.key}=${listing.password.value}`;
      this.#writeControl(
        `${ESC}]5522;type=read${location}:mime=${encodedMimeType}${password}:name=${PASTE_EVENT_NAME}${ST}`,
      );
      return;
    }
    this.#writeControl(`${ESC}]5522;type=read${location};${encodedMimeType}${ST}`);
  }
}

export function installKittyClipboardExtension(
  renderer: CliRenderer,
  options: KittyClipboardExtensionOptions = {},
): KittyClipboardManager {
  const existing = managers.get(renderer);
  if (existing && !existing.isDisposed) {
    existing.configure(options);
    return existing;
  }
  const manager = new KittyClipboardManager(renderer, options);
  managers.set(renderer, manager);
  return manager;
}

export function getKittyClipboardManager(renderer: CliRenderer): KittyClipboardManager {
  return managers.get(renderer) ?? installKittyClipboardExtension(renderer);
}
