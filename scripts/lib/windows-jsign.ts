// Azure Trusted Signing from a non-Windows host, for electron-builder's
// `win.signtoolOptions.sign` hook and the CLI archive. jsign reads AZURE_TENANT_ID,
// AZURE_CLIENT_ID and AZURE_CLIENT_SECRET itself when no --storepass is given.

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Upstream failures worth another attempt: Azure's `InternalError` (seen in
// release runs on both the certificate chain and the sign call), HTTP 429/5xx,
// and dropped connections. Credential, permission and input errors never match.
const TRANSIENT_JSIGN_ERROR =
  /\bInternalError - |HTTP Error (?:429|5\d\d)\b|java\.net\.(?:SocketTimeoutException|ConnectException)\b|Connection reset\b/;
const JSIGN_RETRIES = 3;
const STDERR_TAIL_CHARS = 64 * 1024;

export class JsignFailedError extends Schema.TaggedError<JsignFailedError>()("JsignFailedError", {
  file: Schema.String,
  exitCode: Schema.Number,
  transient: Schema.Boolean,
}) {
  override get message() {
    return `jsign exited with code ${String(this.exitCode)} signing ${this.file}${this.transient ? " (transient Azure Trusted Signing error)" : ""}.`;
  }
}

/** Runs jsign, forwarding its stderr as it arrives and returning a tail of it for classification. */
const runJsign = Effect.fn("runJsign")(function* (jsign: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(jsign, args, { stdout: "inherit", stderr: "pipe" }),
  );
  const decoder = new TextDecoder();
  let stderr = "";
  const [exitCode] = yield* Effect.all(
    [
      child.exitCode.pipe(Effect.map(Number)),
      Stream.runForEach(child.stderr, (chunk) =>
        Effect.sync(() => {
          process.stderr.write(chunk);
          stderr = (stderr + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
        }),
      ),
    ],
    { concurrency: "unbounded" },
  );
  return { exitCode, stderr };
});

export const signWithJsign = Effect.fn("signWithJsign")(function* (file: string) {
  const { jsign, endpoint, account, profile } = yield* Config.all({
    jsign: Config.String("T3CODE_JSIGN").pipe(Config.withDefault("jsign")),
    endpoint: Config.String("AZURE_TRUSTED_SIGNING_ENDPOINT"),
    account: Config.String("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME"),
    profile: Config.String("AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME"),
  });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const args = [
    "--storetype",
    "TRUSTEDSIGNING",
    "--keystore",
    new URL(endpoint).host,
    "--alias",
    `${account}/${profile}`,
    "--alg",
    "SHA-256",
    "--tsaurl",
    "http://timestamp.acs.microsoft.com",
    "--tsmode",
    "RFC3161",
    // jsign appends a nested signature by default; signtool replaces.
    "--replace",
  ];

  let attempt = 0;
  // jsign rewrites its input in place, so each attempt signs a fresh copy and
  // only a copy jsign finished with replaces the file (same directory, so the
  // rename is atomic). A failed attempt never touches the original.
  const signCopy = Effect.gen(function* () {
    attempt++;
    const dir = yield* fs.makeTempDirectoryScoped({
      directory: path.dirname(file),
      prefix: ".jsign-",
    });
    const copy = path.join(dir, path.basename(file));
    yield* fs.copyFile(file, copy);
    const { exitCode, stderr } = yield* runJsign(jsign, [...args, copy]);
    if (exitCode !== 0) {
      const transient = TRANSIENT_JSIGN_ERROR.test(stderr);
      if (transient && attempt <= JSIGN_RETRIES) {
        yield* Effect.logWarning(
          `[jsign] Transient Azure Trusted Signing error signing ${file} (attempt ${String(attempt)} of ${String(JSIGN_RETRIES + 1)}); retrying.`,
        );
      }
      return yield* new JsignFailedError({ file, exitCode, transient });
    }
    yield* fs.rename(copy, file);
  }).pipe(Effect.scoped);

  yield* signCopy.pipe(
    Effect.retry({
      schedule: Schedule.exponential("5 seconds"),
      times: JSIGN_RETRIES,
      while: (error) => error._tag === "JsignFailedError" && error.transient,
    }),
  );
});

export default function sign(configuration: { readonly path: string }): Promise<void> {
  return signWithJsign(configuration.path).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  );
}
