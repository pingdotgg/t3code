// @effect-diagnostics nodeBuiltinImport:off -- terminal escape sequences must not reach setup details.
import type { ProviderInstallDiagnostics } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { sanitizeAcpStderrExcerpt } from "@t3tools/provider-acp/server/stderr";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeUtil from "node:util";

const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_LINE_CHARS = 8_192;

export const makeInstallationDiagnostics = Effect.fn("InstallationDiagnostics.make")(function* (
  step: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const homePatterns = [...new Set([homeDirectory, environment.HOME, environment.USERPROFILE])]
    .filter((home): home is string => typeof home === "string" && home.length > 1)
    .map(
      (home) =>
        new RegExp(
          home
            .split(/[\\/]/u)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
            .join("[\\\\/]"),
          "giu",
        ),
    );
  const normalize = (text: string) => NodeUtil.stripVTControlCharacters(text).replaceAll("\r", "");
  const secrets = Object.entries(environment).flatMap(([name, value]) =>
    /token|password|secret|credential|api[_-]?key|authorization/i.test(name) && value
      ? value.split(/\r?\n/u).map(normalize).filter(Boolean)
      : [],
  );
  const sanitize = (text: string) => {
    let result = normalize(text);
    for (const secret of secrets) result = result.split(secret).join("[redacted]");
    for (const pattern of homePatterns) result = result.replace(pattern, "~");
    return sanitizeAcpStderrExcerpt(result, homeDirectory, environment)
      .replace(/\bauthorization["']?\s*[:=].*/giu, "Authorization: [redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/giu, "[url redacted]")
      .replace(
        /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret|token)(["']?\s*[:=]\s*)(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s,;]+)/giu,
        "$1$2[redacted]",
      );
  };
  let tail = "";
  let pending = "";
  let skippingLine = false;
  let truncated = false;
  let exitCode: number | null = null;
  let systemError: string | undefined;
  const append = (text: string) => {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const part = lines[index]!;
      if (!skippingLine) {
        if (pending.length + part.length > MAX_LINE_CHARS) {
          pending = "";
          skippingLine = true;
          truncated = true;
        } else pending += part;
      }
      if (index < lines.length - 1) {
        const line = skippingLine ? "[oversized diagnostic line omitted]" : sanitize(pending);
        tail += `${line}\n`;
        if (tail.length > MAX_DIAGNOSTIC_CHARS) {
          tail = tail.slice(-MAX_DIAGNOSTIC_CHARS);
          truncated = true;
        }
        pending = "";
        skippingLine = false;
      }
    }
  };
  return {
    spawner: ChildProcessSpawner.make(
      Effect.fn("InstallationDiagnostics.spawn")(function* (command) {
        exitCode = null;
        systemError = undefined;
        const child = yield* spawner.spawn(command).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              systemError =
                error.reason._tag === "NotFound"
                  ? "The runtime executable could not be found."
                  : error.reason._tag === "PermissionDenied"
                    ? "The operating system denied permission to start the runtime."
                    : `The operating system could not start the runtime (${error.reason._tag}).`;
            }),
          ),
        );
        const decoder = new TextDecoder();
        return ChildProcessSpawner.makeHandle({
          ...child,
          stderr: child.stderr.pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => append(decoder.decode(chunk, { stream: true }))),
            ),
            Stream.ensuring(Effect.sync(() => append(decoder.decode()))),
          ),
          exitCode: child.exitCode.pipe(
            Effect.tap((code) =>
              Effect.sync(() => {
                exitCode = Number(code);
              }),
            ),
          ),
        });
      }),
    ),
    snapshot: (exit?: {
      readonly code?: number | undefined;
      readonly signal?: string | undefined;
    }): ProviderInstallDiagnostics => {
      const lastLine = skippingLine ? "[oversized diagnostic line omitted]" : sanitize(pending);
      const text = `${tail}${lastLine}`.trim();
      return {
        step,
        stderr: text.slice(-MAX_DIAGNOSTIC_CHARS),
        exitCode: exit?.code ?? exitCode,
        signal:
          exit?.signal && exit.signal.length <= 32 && /^SIG[A-Z0-9]+$/u.test(exit.signal)
            ? exit.signal
            : null,
        ...(systemError === undefined ? {} : { systemError }),
        truncated: truncated || text.length > MAX_DIAGNOSTIC_CHARS,
      };
    },
  };
});
