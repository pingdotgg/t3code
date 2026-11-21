// @effect-diagnostics-next-line nodeBuiltinImport:off - local Forgejo fixture
import * as NodeHttp from "node:http";

import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

const tea = (origin: string) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("Version: 0.16.0");
} else if (args[0] === "login") {
  console.log(JSON.stringify([{
    name: "scenario", url: ${JSON.stringify(origin)}, user: "theo", default: "true", valid: "true"
  }]));
} else if (args[0] === "api") {
  const response = await fetch(args.at(-1));
  console.error("HTTP/1.1 " + response.status);
  console.log(await response.text());
} else {
  process.exitCode = 1;
}
`;

test(
  "The Forgejo issue assignee filter shows the complete list",
  WEB,
  async ({ t3, app, screen }) => {
    const server = NodeHttp.createServer((request, response) => {
      switch (request.url?.split("?")[0]) {
        case "/api/v1/repos/acme/web/assignees":
          response.end(JSON.stringify([{ login: "theo" }]));
          break;
        case "/api/v1/repos/acme/web/labels":
          // Forgejo sends no `Link` header on labels.
          response.end(JSON.stringify([{ id: 1, name: "bug", color: "d73a4a" }]));
          break;
        case "/api/v1/repos/acme/web/issues":
          response.end("[]");
          break;
        default:
          response.writeHead(404).end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No Forgejo port.");
      const origin = `http://127.0.0.1:${address.port}`;
      const workspace = await t3.project("demo");
      const repository = await runPromise(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const shim = path.join(T3_HOME, "bin", "tea");
          yield* fs.writeFileString(shim, tea(origin));
          yield* fs.chmod(shim, 0o755);
          yield* fs.writeFileString(`${shim}.cmd`, '@node "%~dp0tea.mjs" %*\r\n');
          yield* fs.writeFileString(`${shim}.mjs`, tea(origin));
          return path.join(T3_HOME, "forgejo");
        }),
      );
      await runPromise(run("git", ["clone", "--quiet", workspace, repository]));
      await runPromise(
        run("git", ["remote", "set-url", "origin", `${origin}/acme/web.git`], { cwd: repository }),
      );
      await runPromise(
        makeState(T3_HOME).cli(["project", "add", repository, "--title", "Forgejo"]),
      );

      await t3.open("/issues");
      await screen.getByRole("button", "Filters").tap();
      await screen.getByRole("menuitem", /^Assignee/).tap();
      await screen.getByRole("menuitemradio", "theo").waitFor({ timeout: 60_000 });
      await app.screenshot("forgejo-assignee-filter");
      await expect(screen.getByText("More people exist than are listed here.")).not.toBeVisible();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
