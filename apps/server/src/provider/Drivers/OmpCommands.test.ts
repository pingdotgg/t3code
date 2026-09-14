import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";

import {
  catalogFromCommandEntries,
  decodeOmpCommandCatalog,
  discoverOmpCommandCatalog,
} from "./OmpCommands.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const frame = (commands: ReadonlyArray<unknown>) =>
  // @effect-diagnostics-next-line preferSchemaOverJson:off - building a raw RPC frame.
  JSON.stringify({ type: "available_commands_update", commands });

describe("decodeOmpCommandCatalog", () => {
  it("splits skills from slash commands, each sorted by name", () => {
    const stdout = [
      // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
      JSON.stringify({ type: "ready", protocolVersion: 1 }),
      frame([
        { name: "skill:tdd", description: "Test-driven development." },
        { name: "skill:code-review", description: "Review changes." },
        { name: "model", aliases: ["models"], description: "Show current model selection." },
        { name: "compact", description: "Compact the conversation." },
        { name: "skillful", description: "Toggle skill listing." },
      ]),
      "",
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);

    expect(catalog.skills).toEqual([
      {
        name: "code-review",
        description: "Review changes.",
        path: "skill://code-review/SKILL.md",
        enabled: true,
      },
      {
        name: "tdd",
        description: "Test-driven development.",
        path: "skill://tdd/SKILL.md",
        enabled: true,
      },
    ]);
    expect(catalog.slashCommands).toEqual([
      { name: "compact", description: "Compact the conversation." },
      { name: "model", description: "Show current model selection." },
      { name: "skillful", description: "Toggle skill listing." },
    ]);
  });

  it("keeps a command's argument hint and folds subcommands into the parent", () => {
    const stdout = frame([
      {
        name: "security",
        description: "Run security scans",
        input: { hint: "<plan|scan|status>" },
        subcommands: [
          { name: "plan", description: "Create a plan" },
          { name: "scan", description: "Start a scan" },
        ],
      },
    ]);

    expect(decodeOmpCommandCatalog(stdout).slashCommands).toEqual([
      {
        name: "security",
        description: "Run security scans",
        input: { hint: "<plan|scan|status>" },
      },
    ]);
  });

  it("reads the response payload of an explicit command request", () => {
    const stdout =
      // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
      JSON.stringify({
        type: "response",
        command: "get_available_commands",
        success: true,
        data: { commands: [{ name: "skill:deploy" }, { name: "share" }] },
      });

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills).toEqual([
      { name: "deploy", path: "skill://deploy/SKILL.md", enabled: true },
    ]);
    expect(catalog.slashCommands).toEqual([{ name: "share" }]);
  });

  it("skips malformed lines, nameless entries and blank descriptions", () => {
    const stdout = [
      "not json",
      "null",
      frame([
        { name: "skill:" },
        { name: "skill:  " },
        { name: "   " },
        "not-an-object",
        { name: "skill:keep", description: "   " },
        { name: "todo", input: { hint: "   " } },
      ]),
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills).toEqual([
      { name: "keep", path: "skill://keep/SKILL.md", enabled: true },
    ]);
    expect(catalog.slashCommands).toEqual([{ name: "todo" }]);
  });

  it("keeps the last frame's entry when a command is announced twice", () => {
    const stdout = [
      frame([
        { name: "skill:tdd", description: "First." },
        { name: "model", description: "First." },
      ]),
      frame([
        { name: "skill:tdd", description: "Updated." },
        { name: "model", description: "Updated." },
      ]),
    ].join("\n");

    const catalog = decodeOmpCommandCatalog(stdout);
    expect(catalog.skills[0]?.description).toBe("Updated.");
    expect(catalog.slashCommands[0]?.description).toBe("Updated.");
  });

  it("returns empty catalogs when the output carries no command frame", () => {
    // @effect-diagnostics-next-line preferSchemaOverJson:off - raw RPC frame.
    expect(decodeOmpCommandCatalog(JSON.stringify({ type: "ready" }))).toEqual({
      skills: [],
      slashCommands: [],
    });
  });
});

describe("catalogFromCommandEntries", () => {
  it("splits raw live entries with the same skill: rule as the probe", () => {
    const catalog = catalogFromCommandEntries([
      { name: "skill:tdd", description: "Test-driven development." },
      { name: "skillful", description: "Toggle skill listing." },
      { name: "security", description: "Run security scans", input: { hint: "<plan|scan>" } },
      { name: "skill:" },
      { name: "   " },
      "not-an-object",
    ]);

    expect(catalog.skills).toEqual([
      {
        name: "tdd",
        path: "skill://tdd/SKILL.md",
        enabled: true,
        description: "Test-driven development.",
      },
    ]);
    expect(catalog.slashCommands).toEqual([
      { name: "security", description: "Run security scans", input: { hint: "<plan|scan>" } },
      { name: "skillful", description: "Toggle skill listing." },
    ]);
  });

  it("matches decodeOmpCommandCatalog for the same entries", () => {
    const entries = [
      { name: "skill:deploy", description: "Deploy the app" },
      { name: "share", description: "Share the session" },
      { name: "skill:deploy", description: "Deploy the app (updated)" },
    ];
    expect(catalogFromCommandEntries(entries)).toEqual(decodeOmpCommandCatalog(frame(entries)));
  });
});

/**
 * Fake omp answering `--mode rpc`: it emits the startup command frame, then
 * replies to whatever request arrives on stdin, and records each spawn so the
 * test can prove one process served both catalogs.
 */
const fakeRpcOmpSource = (spawnLogPath: string) =>
  [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(spawnLogPath)}, "spawn\\n");`,
    `process.stdout.write(${JSON.stringify(
      `${frame([
        { name: "compact", description: "Compact the context" },
        { name: "skill:deploy", description: "Deploy the app" },
      ])}\n`,
    )});`,
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(chunk);",
    'const requests = Buffer.concat(chunks).toString("utf8").trim().split("\\n")',
    "  .filter((line) => line.trim().length > 0)",
    "  .map((line) => JSON.parse(line));",
    "for (const request of requests) {",
    '  if (request.type === "get_available_models") {',
    "    process.stdout.write(",
    "      JSON.stringify({",
    "        id: request.id,",
    '        type: "response",',
    '        command: "get_available_models",',
    "        data: {",
    "          models: [",
    '            { id: "claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic", reasoning: true, contextWindow: 1000000, thinking: { mode: "anthropic-adaptive", efforts: ["low", "high"] } },',
    '            { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", reasoning: false, contextWindow: 200000 },',
    "          ],",
    "        },",
    '      }) + "\\n",',
    "    );",
    "  }",
    '  if (request.type === "get_state") {',
    "    process.stdout.write(",
    "      JSON.stringify({",
    "        id: request.id,",
    '        type: "response",',
    '        command: "get_state",',
    '        data: { model: { provider: "anthropic", id: "claude-haiku-4-5" } },',
    '      }) + "\\n",',
    "    );",
    "  }",
    "}",
    "process.exit(0);",
    "",
  ].join("\n");

describe("discoverOmpCommandCatalog", () => {
  effectIt.live("answers both catalogs from a single omp process", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectory({
        directory: NodeOS.tmpdir(),
        prefix: "omp-rpc-catalog-",
      });
      const spawnLogPath = path.join(directory, "spawns.log");
      const binaryPath = writeFakeCli({
        directory,
        name: "fake-omp",
        source: fakeRpcOmpSource(spawnLogPath),
      });

      const catalog = yield* discoverOmpCommandCatalog({ binaryPath });

      expect(catalog.slashCommands.map((command) => command.name)).toEqual(["compact"]);
      expect(catalog.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(catalog.models.metadataBySlug.get("anthropic/claude-sonnet-5")?.contextWindow).toBe(
        1_000_000,
      );
      expect(
        catalog.models.models.filter((model) => model.isDefault === true).map((m) => m.slug),
      ).toEqual(["anthropic/claude-haiku-4-5"]);
      const spawnLog = yield* fileSystem.readFileString(spawnLogPath);
      expect(spawnLog.trim().split("\n")).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
