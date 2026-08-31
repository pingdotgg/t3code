import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DroidSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { DroidCommandInfo, DroidModelInfo, DroidSkillInfo } from "../droid/DroidProtocol.ts";
import { DroidModelInfo as DroidModelInfoSchema } from "../droid/DroidProtocol.ts";
import {
  buildDroidDiscoveredModels,
  buildDroidSkills,
  buildDroidSlashCommands,
  checkDroidProviderStatus,
  detectDroidAuth,
} from "./DroidProvider.ts";

const decodeModelInfo = Schema.decodeUnknownSync(DroidModelInfoSchema);
const decodeSettings = Schema.decodeSync(DroidSettings);
const model = (overrides: Partial<DroidModelInfo> = {}): DroidModelInfo => ({
  id: "claude-opus-5",
  displayName: "Claude Opus 5",
  shortDisplayName: "Opus 5",
  modelProvider: "anthropic",
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "none",
  ...overrides,
});
const expectedSkill = {
  name: "verify",
  path: "/skills/verify/SKILL.md",
  enabled: true,
  scope: "personal" as const,
};
const row = (values: ReadonlyArray<unknown>) => JSON.stringify(values);

const makeInventoryProbeBinary = Effect.fn("makeInventoryProbeBinary")(function* (
  mode: "concurrent" | "commands-error" | "cwd" | "malformed-model",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-droid-provider-" });
  const binaryPath = path.join(directory, "droid");
  yield* fs.writeFileString(
    binaryPath,
    `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv[2] === "--version") { console.log("droid 0.200.0"); process.exit(0); }
const mode = "${mode}", pending = new Map();
let releasedRequestCount;
const write = (message) => console.log(JSON.stringify({ jsonrpc: "2.0",
  factoryApiVersion: "1.0.0", factoryProtocolVersion: "1.187.0", type: "response", ...message }));
function resultFor(method) {
  if (method === "droid.list_models") return { models: [{
    id: mode === "concurrent" ? "concurrent-" + releasedRequestCount : "discovered-model",
    displayName: "Discovered Model", ...(mode === "malformed-model" ? {} : {
      shortDisplayName: "Discovered", modelProvider: "factory",
      supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium"
    }) }]};
  if (method === "droid.list_commands") return { commands: [{ name: "review",
    description: mode === "cwd" ? process.cwd() : "Review changes" }]};
  return { skills: [{ name: "verify", filePath: "/skills/verify/SKILL.md",
    location: "personal", enabled: true }]};
}
function respond(request) {
  if (mode === "commands-error" && request.method === "droid.list_commands")
    return write({ id: request.id, error: { code: -32603, message: "command inventory failed" } });
  write({ id: request.id, result: resultFor(request.method) });
}
function handle(request) {
  if (mode !== "concurrent" || releasedRequestCount !== undefined) return respond(request);
  pending.set(request.id, request);
  if (pending.size === 1) setImmediate(() => {
    releasedRequestCount = pending.size;
    for (const request of pending.values()) respond(request);
    pending.clear();
  });
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => handle(JSON.parse(line)));
input.once("close", () => process.exit(0));`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  return binaryPath;
});

const probe = (
  binaryPath: string,
  options: { readonly customModels?: ReadonlyArray<string>; readonly cwd?: string } = {},
) =>
  checkDroidProviderStatus(
    decodeSettings({ enabled: true, binaryPath, customModels: options.customModels }),
    { FACTORY_API_KEY: "test-key", PATH: process.env.PATH },
    options.cwd,
  );

describe("Droid inventory mapping", () => {
  it("normalizes, filters, dedupes, and identifies models independently of order", () => {
    const discovered = buildDroidDiscoveredModels([
      model(),
      model({ displayName: "Duplicate" }),
      model({
        id: " gpt-5-6-luna ",
        displayName: "  ",
        shortDisplayName: "Luna",
        modelProvider: "openai",
      }),
      model({ id: "retired-model", displayName: "Retired", disabled: true }),
      model({ id: "blank-short-name", displayName: "Blank Short Name", shortDisplayName: "   " }),
    ]);
    assert.deepEqual(
      discovered.map(({ slug, name, shortName, isCustom, isDefault }) =>
        row([slug, name, shortName, isCustom, isDefault]),
      ),
      [
        '["claude-opus-5","Claude Opus 5","Opus 5",false,true]',
        '["gpt-5-6-luna","gpt-5-6-luna","Luna",false,null]',
        '["blank-short-name","Blank Short Name",null,false,null]',
      ],
    );
    assert.isTrue(
      discovered.every(({ capabilities }) => (capabilities?.optionDescriptors?.length ?? 0) === 0),
    );
    const reordered = buildDroidDiscoveredModels([
      model({ id: "gpt-5-6-luna", displayName: "GPT-5.6 Luna", shortDisplayName: "Luna" }),
      model(),
    ]);
    assert.equal(reordered[0]?.isDefault, undefined);
    assert.equal(reordered[1]?.isDefault, true);
  });

  it("surfaces Droid custom models as ordinary probe models", () => {
    const custom = decodeModelInfo({
      id: "custom:factory://kimi-k3",
      displayName: "factory://kimi-k3",
      shortDisplayName: "Kimi K3",
      modelProvider: "generic-chat-completion-api",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "none",
      isCustom: true,
      noImageSupport: false,
      disabled: false,
    });
    const [mapped] = buildDroidDiscoveredModels([custom]);
    assert.equal(
      row([mapped?.slug, mapped?.name, mapped?.shortName, mapped?.isCustom]),
      '["custom:factory://kimi-k3","factory://kimi-k3","Kimi K3",false]',
    );
    assert.deepEqual(mapped?.capabilities?.optionDescriptors, []);
  });

  it("maps reasoning efforts, slash commands, and skills", () => {
    const [reasoning] = buildDroidDiscoveredModels([
      model({
        id: "gpt-5-6-luna",
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      }),
    ]);
    const [descriptor] = reasoning?.capabilities?.optionDescriptors ?? [];
    assert.equal(
      row([descriptor?.id, descriptor?.label, descriptor?.type, descriptor?.currentValue]),
      '["reasoningEffort","Reasoning effort","select","high"]',
    );
    assert.equal(descriptor?.type, "select");
    assert.deepEqual(descriptor?.type === "select" ? descriptor.options : undefined, [
      { id: "low", label: "low" },
      { id: "high", label: "high", isDefault: true },
    ]);

    const commands: ReadonlyArray<DroidCommandInfo> = [
      { name: "review", description: "Review the diff", argumentHint: "<path>" },
      { name: "deploy", description: "  " },
      { name: "review", description: "Shadowed duplicate" },
      { name: "  ", description: "Nameless" },
      { name: "release", description: "Cut a release", argumentHint: "   " },
    ];
    assert.deepEqual(buildDroidSlashCommands(commands), [
      { name: "deploy" },
      { name: "release", description: "Cut a release" },
      { name: "review", description: "Review the diff", input: { hint: "<path>" } },
    ]);

    const skills: ReadonlyArray<DroidSkillInfo> = [
      {
        name: "voice",
        description: "Write like a human.",
        location: "personal",
        filePath: "/home/dev/.factory/skills/voice/SKILL.md",
        enabled: true,
        userInvocable: true,
      },
      {
        name: "open-pr",
        location: "project",
        filePath: "/repo/.agents/skills/open-pr/SKILL.md",
        enabled: false,
      },
      {
        name: "runtime-internal",
        location: "builtin",
        filePath: "/opt/droid/skills/runtime/SKILL.md",
        userInvocable: false,
      },
      {
        name: "builtin-review",
        location: "builtin",
        filePath: "/opt/droid/skills/review/SKILL.md",
      },
      {
        name: "automation-deploy",
        location: "automation",
        filePath: "/opt/droid/skills/deploy/SKILL.md",
      },
    ];
    assert.deepEqual(
      buildDroidSkills(skills).map(
        ({ name, path, enabled, scope, description, shortDescription }) =>
          row([name, path, enabled, scope, description, shortDescription]),
      ),
      [
        '["automation-deploy","/opt/droid/skills/deploy/SKILL.md",true,"app",null,null]',
        '["builtin-review","/opt/droid/skills/review/SKILL.md",true,"system",null,null]',
        '["open-pr","/repo/.agents/skills/open-pr/SKILL.md",false,"project",null,null]',
        '["voice","/home/dev/.factory/skills/voice/SKILL.md",true,"personal","Write like a human.","Write like a human."]',
      ],
    );
    assert.deepEqual(
      buildDroidSkills([{ name: "spec", location: "personal", filePath: "/skills/spec/SKILL.md" }]),
      [{ name: "spec", path: "/skills/spec/SKILL.md", enabled: true, scope: "personal" }],
    );
  });
});

it.layer(NodeServices.layer)("detectDroidAuth", (it) => {
  it.effect("reports every detected credential with unknown validation status", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* detectDroidAuth({ FACTORY_API_KEY: "fk-live", HOME: "/nonexistent" }),
        { status: "unknown", type: "api-key", label: "API key" },
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const { marker, override } of [
        { marker: "auth.v2.keyring", override: true },
        { marker: "auth.v2.loginkeychain", override: false },
      ]) {
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-droid-auth-" });
        yield* fs.makeDirectory(path.join(home, ".factory"), { recursive: true });
        yield* fs.writeFileString(path.join(home, ".factory", marker), "{}");
        assert.deepEqual(
          yield* detectDroidAuth(
            override ? { FACTORY_HOME_OVERRIDE: home, HOME: "/nonexistent" } : { HOME: home },
          ),
          { status: "unknown", type: "oauth", label: "Factory account" },
        );
      }
      const emptyHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-droid-auth-" });
      assert.deepEqual(yield* detectDroidAuth({ HOME: emptyHome }), { status: "unknown" });
    }),
  );
});

it.layer(NodeServices.layer)("checkDroidProviderStatus", (it) => {
  it.effect("probes all inventory dimensions concurrently from the configured cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const concurrent = yield* probe(yield* makeInventoryProbeBinary("concurrent"));
        assert.equal(concurrent.status, "ready");
        assert.deepEqual(concurrent.auth, {
          status: "unknown",
          type: "api-key",
          label: "API key",
        });
        assert.equal(concurrent.message, undefined);
        assert.deepEqual(
          concurrent.models.map(({ slug }) => slug),
          ["concurrent-3"],
        );
        assert.deepEqual(concurrent.slashCommands, [
          { name: "review", description: "Review changes" },
        ]);
        assert.deepEqual(concurrent.skills, [expectedSkill]);

        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-droid-inventory-cwd-" });
        const cwdSnapshot = yield* probe(yield* makeInventoryProbeBinary("cwd"), { cwd });
        assert.equal(cwdSnapshot.slashCommands[0]?.description, cwd);
      }),
    ),
  );

  it.effect("points a missing binary at the supported installer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = "/definitely/not/installed/t3-droid";
        const snapshot = yield* checkDroidProviderStatus(
          decodeSettings({ enabled: true, binaryPath }),
          { PATH: process.env.PATH },
        );
        assert.equal(snapshot.status, "error");
        assert.equal(snapshot.installed, false);
        assert.equal(
          snapshot.message,
          [
            `Droid CLI command \`${binaryPath}\` was not found.`,
            `Install the Droid CLI, make sure \`${binaryPath}\` is on PATH, then restart T3 Code.`,
            "See https://docs.factory.ai/cli/getting-started/quickstart.",
          ].join(" "),
        );
      }),
    ),
  );

  for (const scenario of [
    {
      mode: "commands-error" as const,
      models: ["discovered-model", "custom:test-model"],
      commands: [],
      message: "Droid command inventory failed; slash commands are unavailable.",
    },
    {
      mode: "malformed-model" as const,
      models: ["claude-opus-5", "claude-sonnet-5", "custom:test-model"],
      commands: [{ name: "review", description: "Review changes" }],
      message: "Droid model inventory failed; using fallback models.",
    },
  ]) {
    it.effect(`falls back only the ${scenario.mode} inventory dimension`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* probe(yield* makeInventoryProbeBinary(scenario.mode), {
            customModels: ["custom:test-model"],
          });
          assert.equal(snapshot.status, "warning");
          assert.deepEqual(
            snapshot.models.map(({ slug }) => slug),
            scenario.models,
          );
          assert.deepEqual(snapshot.slashCommands, scenario.commands);
          assert.deepEqual(snapshot.skills, [expectedSkill]);
          assert.equal(snapshot.message, scenario.message);
        }),
      ),
    );
  }
});
