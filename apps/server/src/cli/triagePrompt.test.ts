// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  buildTriageContext,
  buildTriageLaunchPrompt,
  buildTriageSeedPrompt,
  TRIAGE_PLAYBOOK,
} from "./triagePrompt.ts";

it("stays byte-identical to .github/triage/PLAYBOOK.md", () => {
  // Old releases fetch the repo copy from `main` and follow it when it differs
  // from their bundled playbook. The two must say the same thing at HEAD, or a
  // playbook edit silently changes behavior only for old (or only for new)
  // installs. Edit both files together.
  const canonicalPath = NodePath.join(
    import.meta.dirname,
    "../../../../.github/triage/PLAYBOOK.md",
  );
  assert.equal(TRIAGE_PLAYBOOK, NodeFS.readFileSync(canonicalPath, "utf8"));
});

it("seed prompt names the context file and embeds the playbook", () => {
  const prompt = buildTriageSeedPrompt("/tmp/triage-run/context.md");
  assert.include(prompt, "/tmp/triage-run/context.md");
  assert.include(prompt, TRIAGE_PLAYBOOK);
});

it("launch prompt stays a single argv-safe line naming the prompt file", () => {
  // The launch argument goes through cmd.exe on Windows (.cmd shims), which
  // cannot carry newlines; the playbook itself must stay on disk.
  const launch = buildTriageLaunchPrompt(String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.notInclude(launch, "\n");
  assert.include(launch, String.raw`C:\Users\a b\.t3\userdata\triage\x\prompt.md`);
  assert.isBelow(launch.length, 1_000);
});

it("context file carries every path the playbook depends on", () => {
  const context = buildTriageContext({
    generatedAt: "2026-08-13T00:00:00.000Z",
    version: "0.0.33",
    releaseTag: "v0.0.33",
    os: "linux x64 (7.0.0)",
    nodeVersion: "v24.0.0",
    launchedAs: "npx t3 triage",
    server: "running (pid 42, http://127.0.0.1:4501)",
    paths: {
      stateDir: "/home/u/.t3/userdata",
      dbPath: "/home/u/.t3/userdata/state.sqlite",
      settingsPath: "/home/u/.t3/userdata/settings.json",
      logsDir: "/home/u/.t3/userdata/logs",
      serverLogPath: "/home/u/.t3/userdata/logs/server.log",
      serverTracePath: "/home/u/.t3/userdata/logs/server.trace.ndjson",
      providerEventLogPath: "/home/u/.t3/userdata/logs/provider/events.log",
      terminalLogsDir: "/home/u/.t3/userdata/logs/terminals",
      providerStatusCacheDir: "/home/u/.t3/caches",
      secretsDir: "/home/u/.t3/userdata/secrets",
      sourceCacheDir: "/home/u/.t3/source",
    },
  });
  assert.include(context, "/home/u/.t3/userdata/state.sqlite");
  assert.include(context, "/home/u/.t3/userdata/logs/server.trace.ndjson");
  assert.include(context, "/home/u/.t3/userdata/logs/provider/events.log");
  assert.include(context, "/home/u/.t3/userdata/secrets");
  assert.include(context, "/home/u/.t3/source");
  assert.include(context, "npx t3 triage");
  assert.include(context, "v0.0.33");
});
