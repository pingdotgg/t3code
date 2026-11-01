// @effect-diagnostics nodeBuiltinImport:off -- The ANSI code page is only readable through a host probe.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as HostProcess from "./HostProcess.ts";

// Windows CLIs that Python does not run in UTF-8 mode (az, aws) encode piped output in the
// system ANSI code page, so bytes above 0x7f are not UTF-8.
const ANSI_ENCODINGS_BY_CODE_PAGE: Readonly<Record<number, string>> = {
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  54936: "gb18030",
};

/** TextDecoder label for a Windows ANSI code page, or null when its bytes have no text form. */
export const ansiEncodingForCodePage = (codePage: number): string | null =>
  ANSI_ENCODINGS_BY_CODE_PAGE[codePage] ?? null;

const CODE_PAGE_REGISTRY_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";

export const parseCodePageRegistryOutput = (output: string): number | null => {
  const match = /^\s*ACP\s+REG_SZ\s+(\d+)\s*$/mu.exec(output);
  return match === null ? null : Number(match[1]);
};

// A bare `reg` is resolved against the current directory before PATH on Windows, so a checkout
// could supply it; ask the Windows install that started this process instead.
export const windowsRegistryTool = (env: NodeJS.ProcessEnv): string =>
  NodePath.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");

const queryCodePage = (regPath: string): Promise<string | null> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      regPath,
      ["query", CODE_PAGE_REGISTRY_KEY, "/v", "ACP"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
      (error, stdout) => resolve(error === null ? stdout : null),
    );
  });

const readWindowsAnsiEncoding = Effect.fn("windowsCodePage.readWindowsAnsiEncoding")(function* () {
  const environment = yield* HostProcess.Environment;
  const output = yield* Effect.tryPromise(() =>
    queryCodePage(windowsRegistryTool(environment)),
  ).pipe(Effect.orElseSucceed(() => null));
  const codePage = output === null ? null : parseCodePageRegistryOutput(output);
  return codePage === null ? null : ansiEncodingForCodePage(codePage);
});

export const WindowsAnsiEncoding = Context.Reference<Effect.Effect<string | null>>(
  "@t3tools/shared/windowsCodePage/AnsiEncoding",
  { defaultValue: readWindowsAnsiEncoding },
);
