import * as NodeNet from "node:net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ScenarioError } from "./shell.ts";
import { runPromise, test, WEB } from "./t3.ts";

// Serves on the port its last argument ends in, and prints once it listens.
const LISTENER = `require("node:http").createServer((_, res) => res.end("ok")).listen(Number(process.argv.at(-1).split("=").at(-1)), "127.0.0.1", () => console.log("listening"))`;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

/** A listener started as an agent's shell starts one: with the thread in its environment. */
const listen = Effect.fn("scenario.listen")(function* (threadId: string, arg: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const child = yield* spawner.spawn(
    ChildProcess.make(yield* HostProcess.ExecutablePath, ["-e", LISTENER, "--", arg], {
      env: { PATH: hostEnvironment.PATH, HYAKKI_THREAD_ID: threadId },
      extendEnv: false,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  const output = yield* child.stdout.pipe(Stream.decodeText(), Stream.runHead);
  if (!Option.getOrElse(output, () => "").includes("listening")) {
    return yield* new ScenarioError({ message: `The listener for ${arg} exited before listening` });
  }
});

test(
  "An agent browser's DevTools port is not listed with the thread's servers",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Dev server", messages: ["Start"] });
    const [serverPort, devToolsPort] = [await freePort(), await freePort()];
    const scope = await runPromise(Scope.make());
    try {
      await runPromise(
        Effect.all([
          listen(thread.threadId, `${serverPort}`),
          listen(thread.threadId, `--remote-debugging-port=${devToolsPort}`),
        ]).pipe(Scope.provide(scope)),
      );
      await browser.setViewport({ width: 1920, height: 1000 });
      await t3.open(thread);

      const servers = screen.getByRole("region", "Servers");
      await servers.getByText(`localhost:${serverPort}`).waitFor({ timeout: 60_000 });
      await app.screenshot("thread-servers");
      await expect(servers.getByText(`localhost:${devToolsPort}`)).toHaveCount(0);
    } finally {
      await runPromise(Scope.close(scope, Exit.void));
    }
  },
);
