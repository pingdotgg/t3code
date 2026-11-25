import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

const origin = "https://forgejo.test";
const login = [{ name: "scenario", url: origin, user: "theo", default: "true", valid: "true" }];
const tea = `#!/usr/bin/env node
const command = process.argv[2];
const endpoints = { assignees: [{ login: "theo" }], labels: [{ id: 1, name: "bug" }], issues: [] };
if (command === "--version") console.log("Version: 0.16.0");
else if (command === "login") console.log(JSON.stringify(${JSON.stringify(login)}));
else if (command === "api") {
  const url = new URL(process.argv.at(-1));
  const endpoint = /^\\/api\\/v1\\/repos\\/acme\\/web\\/(assignees|labels|issues)$/.exec(url.pathname)?.[1];
  if (url.origin !== "${origin}" || !endpoint) process.exit(1);
  console.error("HTTP/1.1 200 OK");
  if (endpoint === "labels") console.error("X-Total-Count: 1");
  console.log(JSON.stringify(endpoints[endpoint]));
} else process.exitCode = 1;
`;
const shim = `${T3_HOME}/bin/tea`;
const shims = [
  [shim, tea],
  [`${shim}.cmd`, '@node "%~dp0tea" %*\r\n'],
] as const;
const prepareTea = (install: boolean) =>
  runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const [file, data] of shims) {
        yield* install
          ? fs.writeFileString(file, data, { mode: 0o755 })
          : fs.remove(file, { force: true });
      }
    }),
  );

test(
  "The Forgejo issue assignee filter shows the complete list",
  WEB,
  async ({ t3, app, screen }) => {
    try {
      await prepareTea(true);
      await t3.project("Forgejo", {}, `${origin}/acme/web.git`);
      await t3.open("/issues");
      await screen.getByRole("button", "Filters").tap();
      await screen.getByRole("menuitem", /^Assignee/).tap();
      await screen.getByRole("menuitemradio", "theo").waitFor();
      await app.screenshot("forgejo-assignee-filter");
      await expect(screen.getByText("More people exist than are listed here.")).not.toBeVisible();
    } finally {
      await prepareTea(false);
    }
  },
);
