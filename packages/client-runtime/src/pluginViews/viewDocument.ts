/**
 * The document a host mounts for a plugin view, shared by every client.
 *
 * The host sets the result as the `srcdoc` of a frame with
 * `PLUGIN_VIEW_FRAME_ATTRIBUTES`. That frame is a script-free policy wrapper
 * whose CSP (`default-src 'none'`, so `frame-src 'none'`) refuses every
 * network or `data:` navigation of the view inside it: a document's own CSP
 * cannot stop its frame navigating, only the embedding document's can. The
 * view document inside has its own CSP first, listing exactly two scripts by
 * SHA-256: the host bootstrap below and the view's script. The engine checks
 * those hashes against the text it parses, so a script whose bytes differ
 * from the bundle's `sha256` never runs; the host needs no hashing of its own
 * and therefore no secure context.
 *
 * Both frames are sandboxed without `allow-same-origin`: opaque origin, no
 * app cookies, storage, or IPC. The wrapper and view inherit the app
 * document's policy too, so a host page whose own CSP forbids inline script
 * or srcdoc frames cannot show views (fail closed, never widen the app CSP).
 */
import {
  PLUGIN_VIEW_CONNECT_MESSAGE,
  PLUGIN_VIEW_HANDLER_MAX_LENGTH,
  PLUGIN_VIEW_HANDLER_PATTERN,
  PLUGIN_VIEW_MESSAGE_MAX_BYTES,
  PLUGIN_VIEW_MESSAGE_MAX_DEPTH,
  PLUGIN_VIEW_READY_MESSAGE,
  type PluginViewBundle,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** Attributes of the frame the host creates. No `allow-same-origin`, ever. */
export const PLUGIN_VIEW_FRAME_ATTRIBUTES = {
  sandbox: "allow-scripts",
  referrerpolicy: "no-referrer",
  allow: "",
} as const;

/**
 * Runs first in the view document. It takes exactly one port, only from the
 * host window (the wrapper's parent), answers pings, and gives the view
 * script `t3View.ready` (resolves with `{ pluginId, viewId, title }`) and
 * `t3View.call(handler, input, { signal })`, which settles with the plugin's
 * answer or rejects with an Error carrying `code`. A call the host would
 * refuse for its shape, size or depth is rejected here without being sent;
 * an abort rejects at once. The host answers every call it receives, so no
 * call stays pending while the mount lives.
 */
export const PLUGIN_VIEW_BOOTSTRAP_SOURCE = `(() => {
  const host = window.parent.parent;
  const encoder = new TextEncoder();
  const pending = new Map();
  let port = null;
  let nextId = 1;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const send = (message) => port.postMessage(JSON.stringify(message));
  const settle = (id, finish) => {
    const call = pending.get(id);
    if (call === undefined) return;
    pending.delete(id);
    if (call.signal !== undefined) call.signal.removeEventListener("abort", call.cancel);
    finish(call);
  };
  const receive = (event) => {
    if (typeof event.data !== "string") return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message === null || typeof message !== "object") return;
    if (message._tag === "init") resolveReady(Object.freeze({ pluginId: message.pluginId, viewId: message.viewId, title: message.title }));
    else if (message._tag === "ping") send({ _tag: "pong", n: message.n });
    else if (message._tag === "result") settle(message.id, (call) => call.resolve(message.value));
    else if (message._tag === "error") settle(message.id, (call) => call.reject(failure(message.code, message.message)));
    else if (message._tag === "violation") console.warn("T3 Code dropped a message from this view: " + message.reason);
  };
  const tooDeep = (value) => {
    const stack = [[value, 1]];
    while (stack.length > 0) {
      const [current, depth] = stack.pop();
      if (current === null || typeof current !== "object") continue;
      if (depth > ${PLUGIN_VIEW_MESSAGE_MAX_DEPTH}) return true;
      for (const child of Object.values(current)) stack.push([child, depth + 1]);
    }
    return false;
  };
  const call = (handler, input, options) => new Promise((resolve, reject) => {
    const signal = options === undefined ? undefined : options.signal;
    if (signal !== undefined && signal.aborted) return reject(failure("cancelled", "The call was cancelled."));
    if (typeof handler !== "string" || handler.length > ${PLUGIN_VIEW_HANDLER_MAX_LENGTH} || !/${PLUGIN_VIEW_HANDLER_PATTERN.source}/.test(handler)) return reject(failure("invalid", "The handler name is invalid."));
    const id = nextId++;
    let text;
    try { text = JSON.stringify({ _tag: "call", id, handler, input: input === undefined ? null : input }); }
    catch { return reject(failure("invalid", "The call input is not JSON.")); }
    if (encoder.encode(text).length > ${PLUGIN_VIEW_MESSAGE_MAX_BYTES}) return reject(failure("too-large", "The call input is too large."));
    const envelope = JSON.parse(text);
    // A function, Symbol or toJSON() => undefined serializes away, leaving no input.
    if (!("input" in envelope)) return reject(failure("invalid", "The call input is not JSON."));
    if (tooDeep(envelope)) return reject(failure("too-deep", "The call input is nested too deeply."));
    // Serializing ran the input's own toJSON() and getters, which may have aborted the signal.
    if (signal !== undefined && signal.aborted) return reject(failure("cancelled", "The call was cancelled."));
    const cancel = () => settle(id, (pendingCall) => {
      if (pendingCall.sent) send({ _tag: "cancel", id });
      pendingCall.reject(failure("cancelled", "The call was cancelled."));
    });
    // Before any state, so a signal that cannot listen leaves nothing behind.
    if (signal !== undefined) signal.addEventListener("abort", cancel, { once: true });
    const entry = { resolve, reject, signal, cancel, sent: false };
    pending.set(id, entry);
    // A call made before the handshake is checked and cancellable now, and sent once connected.
    ready.then(() => {
      if (pending.get(id) !== entry) return;
      if (signal !== undefined && signal.aborted) return cancel();
      entry.sent = true;
      port.postMessage(text);
    });
  });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data === null || typeof data !== "object" || data.type !== "${PLUGIN_VIEW_CONNECT_MESSAGE}") return;
    event.stopImmediatePropagation();
    if (port !== null || event.source !== host || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = receive;
  });
  Object.defineProperty(window, "t3View", { value: Object.freeze({ ready, call }) });
  host.postMessage({ type: "${PLUGIN_VIEW_READY_MESSAGE}" }, "*");
})();`;

/** Base64 SHA-256 of `PLUGIN_VIEW_BOOTSTRAP_SOURCE`; a test keeps them in step. */
export const PLUGIN_VIEW_BOOTSTRAP_SHA256 = "ct0RJkh/B5f81yANQ/pOR46WVF3JWK5yc+fQtXGZ4YU=";

class PluginViewDocumentError extends Schema.TaggedError<PluginViewDocumentError>()(
  "PluginViewDocumentError",
  { message: Schema.String },
) {}

// The server's inline-safety rules, checked again here (the size limits are the server's alone):
// the parsed text would differ from the hashed bytes.
const UNSAFE_SCRIPT = /<\/script|<!--|<script|[\r\0]/i;
const UNSAFE_STYLE = /<\/style|[\r\0]/i;

const escapeText = (text: string) =>
  text.replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);

/** The wrapper document for the host frame's `srcdoc`, or why the bundle cannot be inlined. */
export const buildPluginViewDocument = (
  bundle: Pick<PluginViewBundle, "script" | "style">,
  title: string,
): Result.Result<string, PluginViewDocumentError> => {
  if (UNSAFE_SCRIPT.test(bundle.script.text) || bundle.script.text.charCodeAt(0) === 0xfeff)
    return Result.fail(
      new PluginViewDocumentError({ message: "The view script cannot be inlined exactly." }),
    );
  if (
    bundle.style !== null &&
    (UNSAFE_STYLE.test(bundle.style.text) || bundle.style.text.charCodeAt(0) === 0xfeff)
  )
    return Result.fail(
      new PluginViewDocumentError({ message: "The view style cannot be inlined exactly." }),
    );
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${PLUGIN_VIEW_BOOTSTRAP_SHA256}' 'sha256-${bundle.script.sha256}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const head = `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${escapeText(title)}</title>`;
  const style = bundle.style === null ? "" : `<style>${bundle.style.text}</style>`;
  const view = `<!doctype html><html><head>${head}${style}<script>${PLUGIN_VIEW_BOOTSTRAP_SOURCE}</script></head><body><script>${bundle.script.text}</script></body></html>`;
  // Escaping only & and " makes the parsed srcdoc attribute equal `view` exactly.
  const srcdoc = view.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const { sandbox, referrerpolicy, allow } = PLUGIN_VIEW_FRAME_ATTRIBUTES;
  return Result.succeed(
    `<!doctype html><html><head>${head}<style>html,body,iframe{margin:0;border:0;width:100%;height:100%;display:block}</style></head><body><iframe sandbox="${sandbox}" referrerpolicy="${referrerpolicy}" allow="${allow}" srcdoc="${srcdoc}"></iframe></body></html>`,
  );
};
