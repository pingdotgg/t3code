import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { makeState, runPromise, test, WEB } from "./t3.ts";

// Stand in for the Azure CLI upstream. The real tracker builds WIQL and decodes its rows.
const azureCli = String.raw`#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argument = (name) => args[args.indexOf(name) + 1];
const changed = existsSync(new URL("./workflow-changed", import.meta.url));
const bugFinished = changed ? "Released" : "Done";
const item = (id, type, title, state) => ({
  id,
  url: "https://dev.azure.com/scenario/_apis/wit/workItems/" + id,
  fields: {
    "System.Title": title,
    "System.State": state,
    "System.TeamProject": "Release",
    "System.WorkItemType": type,
    "System.CreatedDate": "2026-10-01T00:00:00Z",
    "System.ChangedDate": "2026-10-02T00:00:00Z",
  },
});
const items = [
  item(7, "Bug", "Verify the release package", changed ? "Released" : "Active"),
  item(6, "Task", changed ? "Release notes checked" : "Release notes drafted", "Closed"),
];
let output;
switch (argument("--resource")) {
  case "workitemtypes":
    output = { value: [
      { name: "Bug", states: [
        { name: "Active", category: "InProgress" },
        { name: bugFinished, category: "Completed" },
      ] },
      { name: "Task", states: [{ name: "Closed", category: "Completed" }] },
    ] };
    break;
  case "wiql": {
    const { query } = JSON.parse(readFileSync(argument("--in-file"), "utf8"));
    const clause = /\[System\.State\] (NOT )?IN \(([^)]+)\)/.exec(query);
    const names = clause?.[2].match(/'[^']*'/g) ?? [];
    output = { workItems: items.filter((item) => {
      if (!clause) return true;
      const listed = names.includes("'" + item.fields["System.State"].toLowerCase() + "'");
      return clause[1] ? !listed : listed;
    }).map(({ id }) => ({ id })) };
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
  "Refreshing Closed issues picks up a new Azure DevOps finished state",
  WEB,
  async ({ t3, app, screen }) => {
    const workspace = await t3.project("demo");
    const { repository, changed } = await runPromise(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const shim = path.join(T3_HOME, "bin", "az");
        yield* fs.writeFileString(shim, azureCli);
        yield* fs.chmod(shim, 0o755);
        return {
          repository: path.join(T3_HOME, "release"),
          changed: path.join(T3_HOME, "bin", "workflow-changed"),
        };
      }),
    );
    await runPromise(run("git", ["clone", "--quiet", workspace, repository]));
    await runPromise(
      run(
        "git",
        ["remote", "set-url", "origin", "https://dev.azure.com/scenario/Release/_git/release"],
        {
          cwd: repository,
        },
      ),
    );
    const primary = makeState(T3_HOME);
    await runPromise(primary.cli(["project", "add", repository, "--title", "Release"]));
    try {
      await t3.open("/issues?status=closed");
      // The initial Closed list warms the workflow cache.
      await screen.getByText("Release notes drafted", { exact: true }).waitFor({ timeout: 60_000 });
      await runPromise(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(changed, "")),
      );

      await screen.getByRole("button", "Refresh issues", { exact: true }).tap();
      // This title changes with the workflow, so the next assertion sees the completed refresh.
      await screen.getByText("Release notes checked", { exact: true }).waitFor();
      await app.screenshot("closed-issues-after-workflow-change");
      await expect(screen.getByText("Verify the release package", { exact: true })).toBeVisible();
    } finally {
      await runPromise(primary.cli(["project", "remove", repository, "--force"]));
    }
  },
);
