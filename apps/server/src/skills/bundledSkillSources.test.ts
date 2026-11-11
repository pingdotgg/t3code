import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { BundledSkillId } from "@t3tools/contracts";
import { loadBundledSkillSources } from "./bundledSkillSources.ts";

it.effect("ships every supported skill with its instructions, license and prerequisites", () =>
  Effect.gen(function* () {
    const sources = yield* loadBundledSkillSources();
    expect(sources.map((skill) => skill.id)).toEqual(BundledSkillId.literals);
    for (const source of sources) {
      expect(source.files["SKILL.md"]).toContain(`name: ${source.id}`);
      expect(source.files.LICENSE).toContain("MIT License");
      expect(source.requirements).toBeTruthy();
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
