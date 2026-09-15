import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  applyDevinModelSelection,
  DevinSkillCatalog,
  discoverDevinSkills,
  prepareDevinSkillPrompt,
} from "./DevinCli.ts";
import { DevinModelCatalog } from "./DevinModels.ts";

const encodeSkills = Schema.encodeEffect(DevinSkillCatalog);
const isJson = Schema.is(Schema.Json);

const models = Schema.encodeSync(DevinModelCatalog)({
  families: [
    {
      slug: "opus",
      family_label: "Opus",
      variants: [
        { model_uid: "native-high", label: "Opus High" },
        { model_uid: "native-medium", label: "Opus Medium" },
      ],
    },
  ],
});

const makeCli = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-v2-cli-" });
  const command = writeFakeCli({
    directory: cwd,
    name: "devin",
    platform: yield* HostProcessPlatform,
    source: `
      import { readFileSync } from 'node:fs';
      const args = process.argv.slice(2).join(' ');
      if (args === 'models list --format json') console.log(process.env.T3_TEST_MODELS);
      else if (args === 'skills list --json') console.log(readFileSync('skills.json', 'utf8'));
      else process.exit(2);
    `,
  });
  const skill = (name: string, triggers: string[], errors: string[] = []) => ({
    name: "Frontmatter label",
    display_name: name,
    description: "Workspace skill",
    base_dir: path.join(cwd, name),
    triggers,
    errors,
  });
  yield* fs.writeFileString(
    path.join(cwd, "skills.json"),
    yield* encodeSkills([
      skill("review", ["user"]),
      { ...skill("internal", ["model"]), description: "", display_name: "" },
      skill("broken", ["user"], ["invalid"]),
      { ...skill("builtin", ["user"]), base_dir: "" },
    ]),
  );
  return {
    command,
    args: ["acp"],
    cwd,
    env: { ...(yield* HostProcessEnvironment), T3_TEST_MODELS: models },
  };
});

it.effect("resolves options using the configured executable and account environment", () =>
  Effect.gen(function* () {
    const spawn = yield* makeCli;
    const selected: string[] = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.sync(() => {
          selected.push(model);
        }),
    };
    const instanceId = ProviderInstanceId.make("acpRegistry_devin");
    expect(
      yield* applyDevinModelSelection(spawn, runtime, {
        instanceId,
        model: "opus",
        options: [{ id: "reasoningEffort", value: "medium" }],
      }),
    ).toBe("native-medium");
    const error = yield* applyDevinModelSelection(spawn, runtime, {
      instanceId,
      model: "opus",
      options: [{ id: "reasoningEffort", value: "max" }],
    }).pipe(Effect.flip);
    expect(error.message).toContain("unavailable");
    expect(selected).toEqual(["native-medium"]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("discovers skills in the requested workspace and invokes only enabled user skills", () =>
  Effect.gen(function* () {
    const spawn = yield* makeCli;
    const skills = yield* discoverDevinSkills(spawn);
    expect(isJson(skills)).toBe(true);
    expect(
      skills.map(({ name, enabled, userInvocable }) => ({ name, enabled, userInvocable })),
    ).toEqual([
      { name: "broken", enabled: false, userInvocable: true },
      { name: "internal", enabled: true, userInvocable: false },
      { name: "review", enabled: true, userInvocable: true },
    ]);
    expect(yield* prepareDevinSkillPrompt("Check $review please", spawn)).toBe(
      "/review Check  please",
    );
    expect(yield* prepareDevinSkillPrompt("$internal $broken", spawn)).toBe("$internal $broken");
    expect(
      (yield* prepareDevinSkillPrompt("$review $review", spawn).pipe(Effect.flip)).message,
    ).toContain("one skill");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
