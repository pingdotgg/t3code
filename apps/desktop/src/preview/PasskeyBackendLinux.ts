// @effect-diagnostics nodeBuiltinImport:off - IPC callbacks own the subprocess and modal lifetime outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import { BrowserWindow, dialog } from "electron";
import * as Schema from "effect/Schema";
import { QrCode } from "@t3tools/shared/qrCode";

import type { PasskeyBackend, PasskeyCeremonyContext } from "./PasskeyBackend.ts";
import type { PasskeyCeremonyResult } from "./PasskeyBridge.ts";

const Extensions = Schema.Struct({
  credProps: Schema.optionalKey(Schema.Struct({ rk: Schema.optionalKey(Schema.Boolean) })),
  prf: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      results: Schema.optionalKey(
        Schema.Struct({ first: Schema.String, second: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
  largeBlob: Schema.optionalKey(
    Schema.Struct({
      supported: Schema.optionalKey(Schema.Boolean),
      written: Schema.optionalKey(Schema.Boolean),
      blob: Schema.optionalKey(Schema.String),
    }),
  ),
});
const Credential = Schema.Struct({
  id: Schema.String,
  clientExtensionResults: Schema.optionalKey(Extensions),
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.optionalKey(Schema.String),
    signature: Schema.optionalKey(Schema.String),
    userHandle: Schema.optionalKey(Schema.NullOr(Schema.String)),
    attestationObject: Schema.optionalKey(Schema.String),
    publicKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
    publicKeyAlgorithm: Schema.optionalKey(Schema.Number),
  }),
});
const HelperEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("qr"), url: Schema.String }),
  Schema.Struct({ type: Schema.Literal("connected") }),
  Schema.Struct({ type: Schema.Literal("result"), credential: Credential }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(HelperEvent));
const notAllowed: PasskeyCeremonyResult = { success: false, error: "NotAllowedError" };

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const dialogHtml = (origin: string, qrUrl: string, operation: "create" | "get") => {
  const qr = QrCode.encodeText(qrUrl, QrCode.Ecc.MEDIUM);
  const size = qr.size + 8;
  const path: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) path.push(`M${x + 4},${y + 4}h1v1h-1z`);
    }
  }
  const script =
    'document.querySelector("#cancel").addEventListener("click",()=>window.close());document.querySelector("#native").addEventListener("click",()=>location.href="t3-passkey-native://continue")';
  const hash = NodeCrypto.createHash("sha256").update(script).digest("base64");
  const title = operation === "create" ? "Create a passkey" : "Sign in with a passkey";
  const action = operation === "create" ? "create a passkey for" : "sign in to";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${hash}'"><title>${title}</title><style>
    :root{color-scheme:light dark;font:15px system-ui}body{margin:28px;text-align:center}h1{font-size:21px}p{line-height:1.5;overflow-wrap:anywhere}svg{width:272px;height:272px;max-width:100%}button{font:inherit;padding:8px 24px;margin-top:12px;cursor:pointer}#status{min-height:3em}
    </style></head><body><h1>Use your phone or tablet</h1><p>Scan this code to ${action}<br><strong>${escapeHtml(origin)}</strong></p>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Passkey sign-in QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path.join("")}" fill="black"/></svg>
    <p id="status">Keep your phone nearby with Bluetooth enabled on both devices.</p><button id="native">Use a security key</button> <button id="cancel">Cancel</button><script>${script}</script></body></html>`;
};

const encodeOptions = (value: unknown) =>
  JSON.stringify(value, (_key, member: unknown) => {
    if (member instanceof ArrayBuffer) return Buffer.from(member).toString("base64url");
    if (ArrayBuffer.isView(member)) {
      return Buffer.from(member.buffer, member.byteOffset, member.byteLength).toString("base64url");
    }
    return member;
  });

const credentialResult = (credential: typeof Credential.Type): PasskeyCeremonyResult => {
  const response = credential.response;
  const extensions = credential.clientExtensionResults ?? {};
  const { prf, ...otherExtensions } = extensions;
  if (
    response.attestationObject &&
    response.authenticatorData &&
    response.publicKeyAlgorithm !== undefined
  ) {
    return {
      success: true,
      data: {
        credentialId: credential.id,
        clientDataJSON: response.clientDataJSON,
        attestationObject: response.attestationObject,
        authData: response.authenticatorData,
        publicKey: response.publicKey ?? "",
        publicKeyAlgorithm: response.publicKeyAlgorithm,
        transports: ["hybrid"],
        extensions: {
          ...otherExtensions,
          ...(prf ? { prf: { ...prf, results: prf.results ?? {} } } : {}),
        },
      },
    };
  }
  if (response.authenticatorData && response.signature) {
    return {
      success: true,
      data: {
        credentialId: credential.id,
        clientDataJSON: response.clientDataJSON,
        authenticatorData: response.authenticatorData,
        signature: response.signature,
        userHandle: response.userHandle ?? "",
        extensions,
      },
    };
  }
  return notAllowed;
};

export const linuxPasskeyBackend = (executable: string): PasskeyBackend => {
  const run = (
    operation: "create" | "get",
    publicKey: PublicKeyCredentialCreationOptions | PublicKeyCredentialRequestOptions,
    context: PasskeyCeremonyContext,
  ): Promise<PasskeyCeremonyResult> =>
    new Promise((resolve) => {
      if (context.signal.aborted) {
        resolve(notAllowed);
        return;
      }
      const request = encodeOptions({ operation, origin: context.origin, publicKey });
      const child = NodeChildProcess.spawn(executable, [], { stdio: ["pipe", "pipe", "ignore"] });
      const lines = NodeReadline.createInterface({ input: child.stdout });
      let prompt: BrowserWindow | undefined;
      let settled = false;
      let sawEvent = false;
      const finish = (result: PasskeyCeremonyResult) => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", cancel);
        lines.close();
        child.kill();
        if (prompt && !prompt.isDestroyed()) prompt.destroy();
        resolve(result);
      };
      const cancel = () => finish(notAllowed);
      context.signal.addEventListener("abort", cancel, { once: true });
      child.once("error", () =>
        finish({ success: false, error: "NotSupportedError", fallbackToNative: true }),
      );
      const onExit = () =>
        finish(
          sawEvent
            ? notAllowed
            : { success: false, error: "NotSupportedError", fallbackToNative: true },
        );
      child.once("close", onExit);
      child.stdin.on("error", onExit);
      lines.on("line", (line) => {
        if (settled) return;
        try {
          const event = decodeEvent(line);
          sawEvent = true;
          if (event.type === "result") {
            finish(credentialResult(event.credential));
            return;
          }
          if (event.type === "error") {
            finish(notAllowed);
            void dialog
              .showMessageBox(context.window, {
                type: "error",
                message: "Couldn't use your phone's passkey",
                detail: event.message,
                buttons: ["OK"],
              })
              .catch(() => {});
            return;
          }
          if (event.type === "connected") {
            void prompt?.webContents
              .executeJavaScript(
                'document.querySelector("svg").style.display="none";document.querySelector("#status").textContent="Complete the request on your phone."',
              )
              .catch(cancel);
            return;
          }
          if (!/^FIDO:\/\d+$/u.test(event.url) || prompt) {
            cancel();
            return;
          }
          prompt = new BrowserWindow({
            parent: context.window,
            modal: true,
            show: false,
            width: 420,
            height: 600,
            resizable: false,
            minimizable: false,
            maximizable: false,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
          });
          prompt.setMenu(null);
          prompt.on("closed", cancel);
          prompt.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          prompt.webContents.on("will-navigate", (event, url) => {
            event.preventDefault();
            if (url === "t3-passkey-native://continue")
              finish({
                success: false,
                error: "NotSupportedError",
                fallbackToNative: true,
              });
          });
          void prompt
            .loadURL(
              `data:text/html;charset=utf-8,${encodeURIComponent(dialogHtml(context.origin, event.url, operation))}`,
            )
            .then(() => {
              if (!settled) prompt?.show();
            })
            .catch(cancel);
        } catch {
          cancel();
        }
      });
      child.stdin.end(`${request}\n`);
    });
  return {
    create: (publicKey, context) =>
      publicKey.authenticatorSelection?.authenticatorAttachment === "platform"
        ? Promise.resolve({ success: false, error: "NotSupportedError", fallbackToNative: true })
        : run("create", publicKey, context),
    get: (publicKey, context) => run("get", publicKey, context),
  };
};
