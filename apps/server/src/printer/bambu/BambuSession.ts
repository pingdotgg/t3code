// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - A long-lived printer connection that outlives single Effect calls.
/**
 * One MQTT connection per Bambu printer. Printers push partial reports as things change, so the
 * session merges each report onto the last full one and keeps the result ready for the poll loop.
 */
import * as NodeCrypto from "node:crypto";

import { MqttConnectRefusedError, MqttTlsConnection } from "./mqttTls.ts";

export interface BambuVersionInfo {
  readonly productName: string | null;
  readonly firmware: string | null;
}

export interface BambuCommandResult {
  readonly command: string;
  readonly result: string | null;
  readonly reason: string | null;
  readonly atMs: number;
}

export interface BambuSessionTarget {
  /** Address to dial, already checked by the printer URL guard. */
  readonly address: string;
  /** Host as configured, used for display. */
  readonly host: string;
  readonly serial: string;
  readonly accessCode: string;
  readonly ca: ReadonlyArray<string>;
  readonly port?: number;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merges a partial report onto the previous state. Objects merge key by key. Arrays whose items
 * all carry an `id` (AMS units and trays) merge item by item; any other array replaces the old one.
 */
export function mergeBambuReport(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const previous = out[key];
    if (isObject(value) && isObject(previous)) {
      out[key] = mergeBambuReport(previous, value);
    } else if (
      Array.isArray(value) &&
      Array.isArray(previous) &&
      value.length > 0 &&
      value.every((item) => isObject(item) && "id" in item) &&
      previous.every((item) => isObject(item) && "id" in item)
    ) {
      const merged = previous.map((item) => item as JsonObject);
      for (const item of value as JsonObject[]) {
        const index = merged.findIndex((existing) => String(existing.id) === String(item.id));
        if (index === -1) merged.push(item);
        else merged[index] = mergeBambuReport(merged[index]!, item);
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const FULL_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
const IDLE_SESSION_TTL_MS = 3 * 60_000;
const MAX_BACKOFF_MS = 30_000;

export class BambuSession {
  readonly target: BambuSessionTarget;
  #connection: MqttTlsConnection | null = null;
  #report: JsonObject | null = null;
  #version: BambuVersionInfo | null = null;
  #lastMessageAtMs: number | null = null;
  #lastFullRefreshAtMs = 0;
  #lastError: string | null = null;
  #credentialsRejected = false;
  #lastCommandResult: BambuCommandResult | null = null;
  #sequence = 1;
  #backoffMs = 1_000;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #connecting = false;
  #disposed = false;
  #waiters: Array<() => void> = [];
  lastUsedMs = Date.now();

  constructor(target: BambuSessionTarget) {
    this.target = target;
  }

  get connected(): boolean {
    return this.#connection !== null && !this.#connection.closed;
  }
  get report(): JsonObject | null {
    return this.#report;
  }
  get version(): BambuVersionInfo | null {
    return this.#version;
  }
  get lastMessageAtMs(): number | null {
    return this.#lastMessageAtMs;
  }
  get lastError(): string | null {
    return this.#lastError;
  }
  get lastCommandResult(): BambuCommandResult | null {
    return this.#lastCommandResult;
  }

  /** Starts connecting if needed. Safe to call on every poll. */
  ensureStarted(): void {
    this.lastUsedMs = Date.now();
    if (this.#disposed || this.connected || this.#connecting || this.#reconnectTimer) return;
    if (this.#credentialsRejected) return;
    void this.#connect();
  }

  /** Resolves true once a report is available, or false after the timeout. */
  waitForReport(timeoutMs: number): Promise<boolean> {
    if (this.#report) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== done);
        resolve(this.#report !== null);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.push(done);
    });
  }

  /** Sends a command to the printer. Throws when not connected. */
  send(message: JsonObject): void {
    const connection = this.#connection;
    if (!connection || connection.closed) {
      throw new Error(this.#lastError ?? "The printer is not connected.");
    }
    const sequenced = this.#withSequence(message);
    connection.publish(`device/${this.target.serial}/request`, JSON.stringify(sequenced));
  }

  /** Asks for a full report, at most once every few minutes unless forced. */
  requestFullRefresh(force = false): void {
    const now = Date.now();
    if (!force && now - this.#lastFullRefreshAtMs < FULL_REFRESH_MIN_INTERVAL_MS) return;
    this.#lastFullRefreshAtMs = now;
    try {
      this.send({ pushing: { command: "pushall" } });
    } catch {
      // Not connected yet; the next connect asks for a full report anyway.
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#connection?.close();
    this.#connection = null;
    for (const waiter of this.#waiters) waiter();
    this.#waiters = [];
  }

  #withSequence(message: JsonObject): JsonObject {
    const sequenceId = String(this.#sequence);
    this.#sequence += 1;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(message)) {
      out[key] = isObject(value) ? { sequence_id: sequenceId, ...value } : value;
    }
    return out;
  }

  async #connect(): Promise<void> {
    this.#connecting = true;
    try {
      const connection = await MqttTlsConnection.connect(
        {
          host: this.target.address,
          port: this.target.port ?? 8883,
          username: "bblp",
          password: this.target.accessCode,
          clientId: `t3code-${NodeCrypto.randomBytes(6).toString("hex")}`,
          ca: this.target.ca,
          keepAliveSeconds: 30,
        },
        {
          onMessage: (_topic, payload) => this.#handleMessage(payload),
          onClose: (error) => this.#handleClose(error),
        },
      );
      if (this.#disposed) {
        connection.close();
        return;
      }
      this.#connection = connection;
      this.#lastError = null;
      this.#backoffMs = 1_000;
      connection.subscribe(`device/${this.target.serial}/report`);
      this.send({ info: { command: "get_version" } });
      this.#lastFullRefreshAtMs = Date.now();
      this.send({ pushing: { command: "pushall" } });
    } catch (error) {
      this.#lastError = describeConnectError(error, this.target);
      if (error instanceof MqttConnectRefusedError && (error.code === 4 || error.code === 5)) {
        // Retrying a wrong access code only spams the printer; wait for a settings change.
        this.#credentialsRejected = true;
      } else {
        this.#scheduleReconnect();
      }
    } finally {
      this.#connecting = false;
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectTimer) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(MAX_BACKOFF_MS, this.#backoffMs * 2);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (Date.now() - this.lastUsedMs > IDLE_SESSION_TTL_MS) return;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #handleClose(error: Error | null): void {
    this.#connection = null;
    if (this.#disposed) return;
    this.#lastError = error
      ? describeConnectError(error, this.target)
      : "The printer disconnected.";
    this.#scheduleReconnect();
  }

  #handleMessage(payload: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!isObject(message)) return;
    const now = Date.now();
    this.#lastMessageAtMs = now;

    const info = message.info;
    if (isObject(info) && info.command === "get_version" && Array.isArray(info.module)) {
      const ota = info.module.find((module) => isObject(module) && module.name === "ota");
      if (isObject(ota)) {
        this.#version = {
          productName: typeof ota.product_name === "string" ? ota.product_name : null,
          firmware: typeof ota.sw_ver === "string" ? ota.sw_ver : null,
        };
      }
    }

    const print = message.print;
    if (isObject(print)) {
      const command = typeof print.command === "string" ? print.command : null;
      if (command === "push_status" || command === null) {
        this.#report = mergeBambuReport(this.#report ?? {}, print);
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter();
      } else {
        this.#lastCommandResult = {
          command,
          result: typeof print.result === "string" ? print.result : null,
          reason: typeof print.reason === "string" ? print.reason : null,
          atMs: now,
        };
      }
    }
  }
}

function describeConnectError(error: unknown, target: BambuSessionTarget): string {
  if (error instanceof MqttConnectRefusedError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED/.test(message)) {
    return `Nothing is listening on ${target.host}:8883. Check the IP address and that the printer is on.`;
  }
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Timed out/.test(message)) {
    return `Could not reach the printer at ${target.host}. Check the IP address and that this machine is on the same network.`;
  }
  if (/certificate|self.signed|unable to verify|CERT_/i.test(message)) {
    return "The printer's TLS certificate is not from a trusted Bambu authority.";
  }
  return message;
}

const sessions = new Map<string, BambuSession>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function sessionKey(target: BambuSessionTarget): string {
  const codeHash = NodeCrypto.createHash("sha256").update(target.accessCode).digest("hex");
  return `${target.address}|${target.port ?? 8883}|${target.serial.toUpperCase()}|${codeHash}`;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (now - session.lastUsedMs > IDLE_SESSION_TTL_MS) {
        session.dispose();
        sessions.delete(key);
      }
    }
  }, 60_000);
  sweeper.unref?.();
}

/** Returns the shared session for a printer, creating it on first use. */
export function getBambuSession(target: BambuSessionTarget): BambuSession {
  startSweeper();
  const key = sessionKey(target);
  let session = sessions.get(key);
  if (!session) {
    // A changed address, serial or access code replaces any older session for the same serial.
    for (const [otherKey, other] of sessions) {
      if (other.target.serial.toUpperCase() === target.serial.toUpperCase()) {
        other.dispose();
        sessions.delete(otherKey);
      }
    }
    session = new BambuSession(target);
    sessions.set(key, session);
  }
  session.ensureStarted();
  return session;
}
