/// <reference lib="dom" />
import { DEFAULT_TERMINAL_ID, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

const TAIL = "end-of-first-paste";
const OTHER_INPUT = "second-client-input";
const PASTE = "p".repeat(65_536 - 6) + TAIL;

const PROBE = String.raw`import { writeFileSync } from "node:fs";
const file = (name) => new URL(name, import.meta.url);
let received = "";
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  received += chunk.toString();
  if (!received.includes("\x1b[201~")) return;
  const expected = "\x1b[200~" + "p".repeat(65530) + "${TAIL}\x1b[201~";
  const interleaved = "\x1b[200~" + "p".repeat(65530) + "${OTHER_INPUT}${TAIL}\x1b[201~";
  const result = received.startsWith(expected)
    ? "Paste arrived intact"
    : received.startsWith(interleaved)
      ? "Other input landed inside the paste"
      : "Paste arrived with unexpected bytes";
  writeFileSync(file("result"), result);
  process.stdout.write("\x1b[?2004l\r\n" + result + "\r\n");
  process.exit(0);
});
process.stdout.write("\x1b[?2004h");
writeFileSync(file("ready"), "ready");
`;

interface PasteGate {
  readonly waiting: () => boolean;
  readonly release: () => void;
}

test(
  "A second connection cannot insert input inside a web terminal paste",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const cwd = await t3.project("demo", { "paste-probe.mjs": PROBE });
    const thread = await t3.thread({
      project: cwd,
      title: "Shared terminal paste",
      messages: ["hello"],
    });
    const threadId = ThreadId.make(thread.threadId);
    const terminalId = DEFAULT_TERMINAL_ID;
    const origin = app.baseUrl ?? "";
    const read = (name: string) =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.readFileString(`${cwd}/${name}`);
        }).pipe(Effect.orElseSucceed(() => "")),
      );
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["terminal.open"]({ threadId, terminalId, cwd });
      }).pipe(Effect.scoped),
    );

    // Hold the next outgoing chunk to reproduce a slow connection after the first was acknowledged.
    await browser.addInitScript((tail) => {
      let release: (() => void) | undefined;
      const nativeSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string" && data.includes('"tag":"terminal.write"')) {
          const request = JSON.parse(data) as { payload?: { data?: string } };
          if (request.payload?.data?.endsWith(tail + "\x1b[201~")) {
            release = () => nativeSend.call(this, data);
            return;
          }
        }
        nativeSend.call(this, data);
      };
      (window as unknown as { pasteGate: PasteGate }).pasteGate = {
        waiting: () => release !== undefined,
        release: () => release?.(),
      };
    }, TAIL);
    await browser.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await t3.open(thread);
    await screen.getByRole("button", "Toggle terminal drawer").tap();
    const terminal = screen.getByLabel("Terminal input");
    // The terminal surface can appear before its session can accept keystrokes.
    await expect
      .poll(
        async () => {
          await terminal.focus();
          await browser.keyboard.type(`echo ready > '${cwd}/shell-ready'`);
          await browser.keyboard.press("Enter");
          return read("shell-ready");
        },
        { timeout: 30_000 },
      )
      .toBe("ready\n");

    await terminal.focus();
    await browser.keyboard.type(`'${process.execPath}' '${cwd}/paste-probe.mjs'`);
    await browser.keyboard.press("Enter");
    await expect.poll(() => read("ready"), { timeout: 15_000 }).toBe("ready");

    await browser.evaluate((text) => {
      const input = document.querySelector('[aria-label="Terminal input"]');
      if (!input) throw new Error("no terminal input");
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
      return null;
    }, PASTE);
    await expect
      .poll(async () => {
        if (await read("result")) return true;
        return browser.evaluate(() =>
          (window as unknown as { pasteGate: PasteGate }).pasteGate.waiting(),
        );
      })
      .toBe(true);

    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, origin);
        const write = yield* client["terminal.write"]({
          threadId,
          terminalId,
          data: OTHER_INPUT,
        }).pipe(Effect.forkScoped);
        // A server that defers the second client's write may acknowledge it after the paste.
        yield* Fiber.join(write).pipe(Effect.timeoutOption("3 seconds"));
        yield* Effect.promise(() =>
          browser.evaluate(() => {
            (window as unknown as { pasteGate: PasteGate }).pasteGate.release();
            return null;
          }),
        );
        yield* Fiber.join(write);
      }).pipe(Effect.scoped),
    );

    await expect.poll(async () => Boolean(await read("result"))).toBe(true);
    await app.screenshot("paste-after-input-from-second-connection");
    expect(await read("result")).toBe("Paste arrived intact");
  },
);
