import type { ExportTypes } from "../rolldown/export-types.ts";
import { isExportTypes } from "../rolldown/export-types.ts";
import { MODULE_REFERENCE_REGEX } from "../rolldown/plugins/index.ts";
import assert from "node:assert";
import { URL as NodeURL } from "node:url";
import * as vite from "vite";
import type { FetchFunctionOptions } from "vite/module-runner";
import {
  ENVIRONMENT_NAME_HEADER,
  EXPORT_TYPES_EVENT,
  INIT_PATH,
  REQUEST_EXPORT_TYPES_EVENT,
} from "./module-runner/constants.shared.ts";

/** How long to wait for the Worker to report its export types before giving up. */
const EXPORT_TYPES_TIMEOUT_MS = 10_000;

export class DistilledDevEnvironment extends vite.DevEnvironment {
  transport: HotChannel;

  constructor(name: string, config: vite.ResolvedConfig) {
    const transport = new HotChannel();
    super(name, config, {
      hot: true,
      transport,
    });
    this.transport = transport;
  }

  async connect(address: string | globalThis.URL) {
    const url = new NodeURL(address.toString());
    url.protocol = "ws";
    url.pathname = INIT_PATH;
    // The Worker ambient declaration hides Bun's headers overload when both
    // runtime type libraries are loaded by the consolidated package config.
    const ws = new (WebSocket as unknown as {
      new (
        url: string,
        options: { headers: Record<string, string> },
      ): WebSocket;
    })(url.toString(), {
      headers: { [ENVIRONMENT_NAME_HEADER]: this.name },
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        resolve();
      });
      ws.addEventListener("error", (event) => {
        // Depending on which global WebSocket type wins (bun-types vs
        // @types/node's undici), the event may or may not carry `error`.
        reject(
          "error" in event
            ? event.error
            : new Error("WebSocket connection error"),
        );
      });
    });
    this.transport.ws = ws;
  }
  override async close(): Promise<void> {
    await super.close();
    // `transport.close()` is idempotent; make sure the module-runner socket is
    // released even if Vite didn't close the hot channel itself.
    this.transport.close();
  }

  /**
   * Asks the Worker to evaluate the entry module and classify its exports.
   *
   * Resolves to `undefined` if the Worker could not evaluate the entry — the
   * error is surfaced to the user by whichever request hits the entry next, and
   * the dev server keeps whatever export types it already has.
   */
  async requestExportTypes(
    timeoutMs: number = EXPORT_TYPES_TIMEOUT_MS,
  ): Promise<ExportTypes | undefined> {
    return await new Promise<ExportTypes | undefined>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const listener = (data: unknown) => {
        clearTimeout(timer);
        this.transport.off(EXPORT_TYPES_EVENT, listener);
        resolve(isExportTypes(data) ? data : undefined);
      };
      timer = setTimeout(() => {
        this.transport.off(EXPORT_TYPES_EVENT, listener);
        resolve(undefined);
      }, timeoutMs);
      this.transport.on(EXPORT_TYPES_EVENT, listener);
      this.transport.send({
        type: "custom",
        event: REQUEST_EXPORT_TYPES_EVENT,
      });
    });
  }

  override async fetchModule(
    id: string,
    importer?: string,
    options?: FetchFunctionOptions,
  ): Promise<vite.FetchResult> {
    // Additional modules (CompiledWasm, Data, Text) are resolved to
    // `__CLOUDFLARE_MODULE__...` ids and must be externalized so the module
    // runner loads them via native `import()` → workerd's module fallback.
    if (MODULE_REFERENCE_REGEX.test(id)) {
      return {
        externalize: id,
        type: "module",
      };
    }
    return super.fetchModule(id, importer, options);
  }
}

class HotChannel implements vite.HotChannel {
  #ws?: WebSocket;
  queue?: Array<string>;
  listeners = new Map<string, Set<vite.HotChannelListener>>();

  /**
   * Replaces the socket, which also happens when the Worker runtime is
   * restarted mid-session.
   *
   * Messages are dispatched from the moment a socket is attached rather than
   * from `listen()`: the dev server queries the Worker for its export types
   * during `configureServer`, which is before Vite calls `listen()`.
   */
  set ws(ws: WebSocket) {
    this.#ws?.removeEventListener("message", this.boundDispatch);
    this.#ws = ws;
    ws.addEventListener("message", this.boundDispatch);
    if (this.queue) {
      for (const message of this.queue) {
        ws.send(message);
      }
      this.queue = undefined;
    }
  }

  send(payload: vite.CustomPayload) {
    const json = JSON.stringify(payload);
    if (this.#ws) {
      this.#ws.send(json);
    } else {
      this.queue ??= [];
      this.queue.push(json);
    }
  }

  on(event: string, listener: vite.HotChannelListener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: vite.HotChannelListener) {
    this.listeners.get(event)?.delete(listener);
  }

  private boundDispatch = this.dispatch.bind(this);

  listen() {
    assert(this.#ws, "WebSocket is not connected");
    // Already dispatching — see the `ws` setter.
  }

  close() {
    // The channel can be closed before a runner ever connected (e.g. a dev
    // server created and torn down during a framework's type generation), so
    // tolerate a missing socket — and close it so the runtime connection does
    // not leak across server restarts.
    if (!this.#ws) return;
    this.#ws.removeEventListener("message", this.boundDispatch);
    this.#ws.close();
    this.#ws = undefined;
  }

  private dispatch(event: MessageEvent) {
    const payload = JSON.parse(event.data.toString()) as vite.CustomPayload;

    const listeners = this.listeners.get(payload.event) ?? new Set();
    for (const listener of listeners) {
      listener(payload.data, this.client);
    }
  }

  private client: vite.HotChannelClient = {
    send: (payload) => {
      assert(this.#ws, "WebSocket is not connected");

      this.#ws.send(JSON.stringify(payload));
    },
  };
}
