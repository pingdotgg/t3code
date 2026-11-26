import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { rpcClient, runPromise, test, WEB } from "./t3.ts";

// Stands in for `az`: logs each call's argv and stdin, then resolves `--repository` the way az
// does, where `@-` reads stdin and any other `@path` reads that file.
const azureCli = String.raw`#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("azure-cli 2.70.0\nazure-devops 1.0.1");
  process.exit(0);
}
if (args[0] === "account") {
  console.log("scenario@example.com");
  process.exit(0);
}
const stdin = args.some((arg) => arg.endsWith("=@-")) ? readFileSync(0, "utf8") : undefined;
const lines = ["--- az call", ...args.map((arg) => "arg: " + arg)];
if (stdin !== undefined) lines.push("stdin: " + stdin);
appendFileSync(new URL("../az-calls.log", import.meta.url), lines.join("\n") + "\n");

const option = (name) => {
  const joined = args.find((arg) => arg.startsWith(name + "="));
  if (joined !== undefined) return joined.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const value = (raw) => {
  if (raw === "@-") return stdin;
  if (raw?.startsWith("@")) {
    try {
      return readFileSync(raw.slice(1), "utf8").trim();
    } catch (error) {
      console.error("ERROR: " + error.message);
      process.exit(1);
    }
  }
  return raw;
};
if (args[0] === "repos" && args[1] === "show") {
  const name = value(option("--repository"));
  const project = value(option("--project")) ?? "project";
  const url = "https://dev.azure.com/acme/" + project + "/_git/" + encodeURIComponent(name);
  console.log(JSON.stringify({
    name,
    webUrl: url,
    remoteUrl: url,
    sshUrl: "git@ssh.dev.azure.com:v3/acme/" + project + "/" + encodeURIComponent(name),
    project: { name: project },
    defaultBranch: "refs/heads/main",
  }));
  process.exit(0);
}
process.exit(1);
`;

// The name az would read as a file. A `/` would split it into project and repository, so the
// path is relative to where az runs.
const REPOSITORY = "project/@hostname";

test(
  "An Azure DevOps repository lookup hands az an @-name as a value, not a file to read",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const project = await t3.project("demo");
    const thread = await t3.thread({ project, title: "Current work", messages: ["Start"] });
    const log = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const shim = path.join(T3_HOME, "bin", "az");
        yield* fs.writeFileString(shim, azureCli);
        yield* fs.chmod(shim, 0o755);
        const client = yield* rpcClient(T3_HOME, origin);
        yield* client["server.updateSettings"]({
          patch: { offeredSourceControlProviders: { "azure-devops": true } },
        });
        return path.join(T3_HOME, "az-calls.log");
      }).pipe(Effect.scoped),
    );

    await t3.open(thread);
    await screen.getByText("Start", { exact: true }).waitFor({ timeout: 30_000 });
    await browser.keyboard.press("Control+k");
    const palette = screen.getByRole("dialog", "Command palette");
    await palette.getByRole("combobox").fill("> Add project");
    await palette.getByText("Add project", { exact: true }).tap();
    await palette.getByRole("option", /^Azure DevOps repository/).tap();
    await palette.getByRole("combobox").fill(REPOSITORY);
    await screen.getByRole("button", "Lookup (Enter)").tap();
    await screen
      .getByText(/Repository lookup failed|^project\/@hostname$/)
      .first()
      .waitFor({ timeout: 30_000 });
    await app.screenshot("azure-repository-lookup-result");

    const calls = await runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(log)),
    );
    const show = calls
      .split("--- az call\n")
      .find((call) => call.includes("arg: repos\narg: show\n"));
    expect(show, "az ran `repos show`").toBeDefined();
    expect(show, "az never gets the name as a separate token it would read as a file").not.toMatch(
      /^arg: @hostname$/m,
    );
    expect(show, "the repository option reads its value from stdin").toMatch(
      /^arg: --repository=@-$/m,
    );
    expect(show, "stdin carries the name as typed").toMatch(/^stdin: @hostname$/m);
  },
);
