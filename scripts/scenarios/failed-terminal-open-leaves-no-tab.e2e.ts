/// <reference lib="dom" />
import { expect } from "e2e";
import * as Effect from "effect/Effect";

import { ThreadId } from "@t3tools/contracts";
import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

test(
  "A rejected terminal launch leaves no extra terminal tab",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Shell", messages: ["First"] });
    await runPromise(
      Effect.gen(function* () {
        const client = yield* rpcClient(T3_HOME, app.baseUrl ?? "");
        yield* client["terminal.open"]({
          threadId: ThreadId.make(thread.threadId),
          terminalId: "kept-shell",
          cwd: project,
        });
      }).pipe(Effect.scoped),
    );

    await browser.addInitScript(() => {
      const opens = new WeakMap<WebSocket, string>();
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        for (const message of typeof data === "string" ? [JSON.parse(data)].flat() : []) {
          if (message?._tag === "Request" && message.tag === "terminal.open") {
            opens.set(this, String(message.id));
          }
        }
        return send.call(this, data);
      };
      const listen = WebSocket.prototype.addEventListener;
      WebSocket.prototype.addEventListener = function (
        this: WebSocket,
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type !== "message" || typeof listener !== "function") {
          return listen.call(this, type, listener, options);
        }
        return listen.call(
          this,
          type,
          (event: Event) => {
            listener.call(this, event);
            const { data } = event as MessageEvent;
            const messages = typeof data === "string" ? [JSON.parse(data)].flat() : [];
            if (
              messages.some(
                (message) =>
                  message?._tag === "Exit" &&
                  String(message.requestId) === opens.get(this) &&
                  message.exit?.cause?.some(
                    (cause: { error?: { _tag?: string } }) =>
                      cause.error?._tag === "TerminalCwdNotFoundError",
                  ),
              )
            ) {
              document.documentElement.dataset.scenarioTerminalOpen = "missing-folder";
            }
          },
          options,
        );
      } as typeof WebSocket.prototype.addEventListener;
    });

    await t3.open(thread);
    await screen.getByRole("button", "Toggle terminal drawer").tap();
    await screen.getByLabel("Terminal input").waitFor();

    // The existing shell can stay open even when the project directory moves.
    await runPromise(run("mv", [project, `${project}-moved`]));
    const drawer = browser.locator("[data-thread-terminal-drawer]");
    await drawer.getByRole("button", /^New Terminal/).tap();
    await browser.locator("html[data-scenario-terminal-open=missing-folder]").waitFor();
    await app.screenshot("drawer-after-new-terminal-fails");
    const failedShellTab = drawer.getByRole("button", "Terminal 1", { exact: true });
    expect(await failedShellTab.isVisible()).toBe(false);

    await drawer.getByLabel("Terminal input").focus();
    await browser.keyboard.type("touch ./shell-survived");
    await browser.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (
            await runPromise(
              run("test", ["-f", `${project}-moved/shell-survived`], { allowExit: [0, 1] }),
            )
          ).exitCode,
      )
      .toBe(0);
  },
);
