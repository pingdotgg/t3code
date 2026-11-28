import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { MOBILE, MOBILE_T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise } from "./t3.ts";
import { IOS, test } from "./t3-mobile.ts";

// Stand in for the Azure CLI upstream: 60 open work items, so the list's first 50 have a next
// page. It counts each request for that page and refuses it while `next-page-fails` exists.
const azureCli = String.raw`#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
const items = Array.from({ length: 60 }, (_, index) => {
  const id = 60 - index;
  return {
    id,
    url: "https://dev.azure.com/scenario/_apis/wit/workItems/" + id,
    fields: {
      "System.Title": "Release check " + id,
      "System.State": "Active",
      "System.TeamProject": "Release",
      "System.WorkItemType": "Task",
      "System.CreatedDate": "2026-10-01T00:00:00Z",
      "System.ChangedDate": new Date(Date.UTC(2026, 9, 2, 0, id)).toISOString(),
    },
  };
});
let output;
switch (argument("--resource")) {
  case "workitemtypes":
    output = { value: [{ name: "Task", states: [
      { name: "Active", category: "InProgress" },
      { name: "Closed", category: "Completed" },
    ] }] };
    break;
  case "wiql": {
    const { query } = JSON.parse(readFileSync(argument("--in-file"), "utf8"));
    const before = /\[System\.Id\] < (\d+)/.exec(query)?.[1];
    if (before !== undefined) {
      appendFileSync(new URL("./next-page-requests", import.meta.url), ".");
      if (existsSync(new URL("./next-page-fails", import.meta.url))) {
        console.error("ERROR: The request timed out.");
        process.exit(1);
      }
    }
    output = { workItems: items
      .filter((item) => before === undefined || item.id < Number(before))
      .map(({ id }) => ({ id })) };
    break;
  }
  case "workitemsbatch": {
    const { ids } = JSON.parse(readFileSync(argument("--in-file"), "utf8"));
    output = { value: items.filter(({ id }) => ids.includes(id)) };
    break;
  }
  default:
    if (args[0] === "repos" && args[1] === "show") {
      output = {
        name: "release",
        project: { name: "Release" },
        webUrl: "https://dev.azure.com/scenario/Release/_git/release",
        remoteUrl: "https://dev.azure.com/scenario/Release/_git/release",
        sshUrl: "git@ssh.dev.azure.com:v3/scenario/Release/release",
      };
      break;
    }
    process.exit(1);
}
console.log(JSON.stringify(output));
`;

test(
  "A failed next page of issues waits for Try again instead of loading again on scroll",
  IOS,
  async ({ t3, app, screen }) => {
    const workspace = await t3.project("demo");
    const { repository, fails, requests } = await runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const bin = path.join(MOBILE_T3_HOME, "bin");
        yield* fs.writeFileString(path.join(bin, "az"), azureCli);
        yield* fs.chmod(path.join(bin, "az"), 0o755);
        yield* fs.writeFileString(path.join(bin, "next-page-fails"), "");
        yield* fs.writeFileString(path.join(bin, "next-page-requests"), "");
        return {
          repository: path.join(MOBILE_T3_HOME, "release"),
          fails: path.join(bin, "next-page-fails"),
          requests: path.join(bin, "next-page-requests"),
        };
      }),
    );
    const nextPageRequests = () =>
      runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(requests)).pipe(
          Effect.map((asked) => asked.length),
        ),
      );
    await runPromise(run("git", ["clone", "--quiet", workspace, repository]));
    await runPromise(
      run(
        "git",
        ["remote", "set-url", "origin", "https://dev.azure.com/scenario/Release/_git/release"],
        { cwd: repository },
      ),
    );
    const primary = makeState(MOBILE_T3_HOME, { T3CODE_PORT: String(MOBILE.serverPort) });
    await runPromise(primary.cli(["project", "add", repository, "--title", "Release"]));
    try {
      // A local simulator keeps the last run's pairing.
      await app.clearState().catch(() => {});
      await t3.open();
      // Pull requests and issues share one tab; its title switches between them.
      await screen.getByRole("tab", "PRs").tap({ timeout: 120_000 });
      await screen.getByLabel("Pull requests, switch list").tap();
      await screen.getByRole("button", "Issues").tap();
      await screen.getByRole("button", /Release check 60,/).waitFor({ timeout: 60_000 });

      const lastOfFirstPage = screen.getByRole("button", /Release check 11,/);
      const toTheEnd = async () => {
        await screen.scrollUntilVisible(lastOfFirstPage, { direction: "down", momentum: "fast" });
        await screen.swipe({ direction: "down" });
      };
      const retry = screen.getByRole("button", "Retry loading more issues");
      await toTheEnd();
      // Reaching the end asks for the next page, which fails.
      await expect(retry).toBeVisible();
      expect(await nextPageRequests()).toBe(1);
      await app.screenshot("end-of-the-list-after-the-next-page-failed");

      // Back toward the top and to the end again, without a tap.
      await screen.swipe({ direction: "up" });
      await screen.swipe({ direction: "up" });
      await app.screenshot("back-toward-the-top");
      await toTheEnd();
      await app.screenshot("end-of-the-list-again");
      await expect(retry).toBeVisible();
      expect(await nextPageRequests()).toBe(1);

      await runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(fails)));
      await retry.tap();
      await expect(screen.getByRole("button", /Release check 10,/)).toBeVisible();
      await app.screenshot("next-page-after-try-again");
    } finally {
      await runPromise(primary.cli(["project", "remove", repository, "--force"]));
    }
  },
);
