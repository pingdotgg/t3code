import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { expect } from "e2e";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";

import { APP_DIR, T3_HOME } from "../e2e.config.ts";
import { prepareHome, start } from "./start-app.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const SECOND_HOME = `${T3_HOME}-second-environment`;

/** A second server on its own T3 home, running until interrupted. `--dev-url` admits the web
 * origin through CORS and registers the replay agent; `paired` gets the Add environment input. */
const runSecondServer = Effect.fn("scenario.secondServer")(function* (
  devUrl: string,
  paired: (target: { readonly host: string; readonly token: string }) => void,
) {
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const hostEnvironment = yield* HostProcess.Environment;
  const port = yield* (yield* NetService.NetService).reserveLoopbackPort();
  yield* prepareHome(SECOND_HOME);
  const token = yield* Deferred.make<string>();
  yield* start({
    cwd: APP_DIR,
    command: node,
    args: [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      SECOND_HOME,
      "--dev-url",
      devUrl,
    ],
    env: {
      PATH: `${path.join(SECOND_HOME, "bin")}:${hostEnvironment.PATH ?? ""}`,
      HOME: hostEnvironment.HOME,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    },
    onLine: (line) => {
      const value = /^Token:\s*(\S+)/.exec(line)?.[1];
      return value === undefined ? Effect.void : Deferred.succeed(token, value).pipe(Effect.asVoid);
    },
  });
  paired({ host: `http://127.0.0.1:${port}`, token: yield* Deferred.await(token) });
  return yield* Effect.never;
});

test(
  "Removing an environment closes the in-app notifications it raised",
  WEB,
  async ({ t3, app, screen, browser }) => {
    const project = await t3.project("demo");
    const primaryThread = await t3.thread({
      project,
      title: "Finished here",
      messages: ["first"],
    });
    const primary = makeState(T3_HOME);
    const second = makeState(SECOND_HOME);
    const pairing = Promise.withResolvers<{ host: string; token: string }>();
    const server = Effect.runFork(
      runSecondServer(app.baseUrl ?? "", pairing.resolve).pipe(
        Effect.scoped,
        Effect.provide([NodeServices.layer, NetService.layer]),
      ),
    );
    server.addObserver(() => pairing.reject(new Error("The second server stopped.")));
    try {
      const { host, token } = await pairing.promise;
      const project = await second.state.project("remote-demo");
      const thread = await second.state.thread({
        project,
        title: "Finished elsewhere",
        messages: ["first"],
      });

      await t3.open("/settings/general");
      await screen.getByRole("switch", "In-app notifications").check();
      await app.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      const moreActions = screen.getByRole("button", "More actions for Scenario");
      await expect(moreActions).toBeVisible({ timeout: 60_000 });

      // The client announces only a change it saw happen, so it must hold the thread first.
      await expect(screen.getByText("Finished elsewhere").first()).toBeVisible({ timeout: 60_000 });
      await runPromise(
        primary.cli(["thread", "send", primaryThread.threadId, "second", "--wait", "--json"]),
      );
      const primaryToast = browser.locator(
        '[data-slot="toast-description"]:has-text("Finished here")',
      );
      await expect(primaryToast).toBeVisible({ timeout: 60_000 });
      await primaryToast.hover();
      await runPromise(
        second.cli(["thread", "send", thread.threadId, "second", "--wait", "--json"]),
      );
      const toast = browser.locator(
        '[data-slot="toast-description"]:has-text("Finished elsewhere")',
      );
      await expect(toast).toBeVisible({ timeout: 60_000 });

      // A hovered toast does not time out. The removal goes by keyboard so the pointer stays.
      await toast.hover();
      await moreActions.press("Enter");
      await screen.getByRole("menuitem", "Remove from this device…").press("Enter");
      await expect(toast).toBeVisible();
      await screen.getByRole("button", "Confirm").press("Enter");
      try {
        await expect(toast).toBeHidden();
        // Both timers pause together; an older surviving toast rules out auto-dismissal.
        await expect(primaryToast).toBeVisible();
      } finally {
        await app.screenshot("after-removal");
      }
      await expect(moreActions).toBeHidden({ timeout: 30_000 });
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
    }
  },
);
