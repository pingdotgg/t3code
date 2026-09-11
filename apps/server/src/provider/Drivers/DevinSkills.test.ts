import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverDevinSkills, prepareDevinSkillPrompt } from "./DevinSkills.ts";
import { makeDevinCli, devinTestLayer, encodeDevinSkills } from "../testUtils/devinCli.ts";

const skill = (name: string, triggers = ["user", "model"]) => ({
  name,
  description: `Use ${name}.`,
  base_dir: `/skills/${name}`,
  display_name: name,
  triggers,
  errors: [],
});

it.effect(
  "uses the CLI catalog for each workspace, including invocation policy and display names",
  () =>
    Effect.gen(function* () {
      const h = yield* makeDevinCli();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(h.root, "devin-test-skills.json"),
        encodeDevinSkills([
          { ...skill("visual-check", ["user"]), display_name: "Visual check" },
          skill("internal", ["model"]),
          { ...skill("broken"), errors: ["Invalid frontmatter"] },
          { ...skill("builtin-command"), base_dir: "" },
        ]),
      );
      const skills = yield* discoverDevinSkills(h.settings, h.environment, h.root);
      expect(skills).toEqual([
        expect.objectContaining({ name: "broken", enabled: false }),
        expect.objectContaining({ name: "internal", enabled: true, userInvocable: false }),
        expect.objectContaining({
          name: "visual-check",
          displayName: "Visual check",
          path: path.join("/skills/visual-check", "SKILL.md"),
          enabled: true,
          userInvocable: true,
          userInvocationOnly: true,
        }),
      ]);
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-other-project-" });
      expect(yield* discoverDevinSkills(h.settings, h.environment, other)).toEqual([]);
    }).pipe(Effect.provide(devinTestLayer)),
);

it.effect(
  "invokes a picked user-only skill while retaining arguments and literal dollar tokens",
  () =>
    Effect.gen(function* () {
      const h = yield* makeDevinCli();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(h.root, "devin-test-skills.json"),
        encodeDevinSkills([skill("visual-check", ["user"]), skill("internal", ["model"])]),
      );
      for (const [input, expected] of [
        ["$visual-check", "/visual-check"],
        ["Please $visual-check inspect localhost", "/visual-check Please  inspect localhost"],
        [
          "$visual-check\nKeep $HOME and $20k unchanged",
          "/visual-check Keep $HOME and $20k unchanged",
        ],
        ["$internal", "$internal"],
        ["/visual-check", "/visual-check"],
      ] as const) {
        expect(yield* prepareDevinSkillPrompt(input, h.settings, h.environment, h.root)).toBe(
          expected,
        );
      }
      const multiple = yield* prepareDevinSkillPrompt(
        "$visual-check $visual-check",
        h.settings,
        h.environment,
        h.root,
      ).pipe(Effect.result);
      expect(multiple._tag).toBe("Failure");
    }).pipe(Effect.provide(devinTestLayer)),
);

it.effect("surfaces failed discovery so it can be retried, without probing ordinary prompts", () =>
  Effect.gen(function* () {
    const h = yield* makeDevinCli({ T3_DEVIN_FAIL_SKILLS: "1" });
    expect(yield* prepareDevinSkillPrompt("Say hello", h.settings, h.environment, h.root)).toBe(
      "Say hello",
    );
    expect(yield* prepareDevinSkillPrompt("Print $HOME", h.settings, h.environment, h.root)).toBe(
      "Print $HOME",
    );
    const failed = yield* discoverDevinSkills(h.settings, h.environment, h.root).pipe(
      Effect.result,
    );
    expect(failed._tag).toBe("Failure");
  }).pipe(Effect.provide(devinTestLayer)),
);
