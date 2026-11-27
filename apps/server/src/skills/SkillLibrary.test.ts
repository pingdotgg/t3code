import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  assertSafeRelativePath,
  assertSafeSkillName,
  injectSkills,
  listSkillLibrary,
  readSkillLibraryBundle,
  resolveSkillInjectTargetDirectory,
} from "./SkillLibrary.ts";

describe("SkillLibrary", () => {
  it("rejects unsafe skill names and relative paths", () => {
    assert.strictEqual(assertSafeSkillName("spec-design"), "spec-design");
    assert.throws(() => assertSafeSkillName("../escape"));
    assert.throws(() => assertSafeSkillName("a/b"));

    assert.strictEqual(assertSafeRelativePath("SKILL.md"), "SKILL.md");
    assert.strictEqual(assertSafeRelativePath("references\\guide.md"), "references/guide.md");
    assert.throws(() => assertSafeRelativePath("../secret.txt"));
    assert.throws(() => assertSafeRelativePath("/etc/passwd"));
    assert.throws(() => assertSafeRelativePath("C:\\Windows\\system.ini"));
  });

  it("maps inject targets to standard user skill directories", () => {
    assert.strictEqual(
      resolveSkillInjectTargetDirectory("agents", "/home/dev"),
      NodePath.join("/home/dev", ".agents", "skills"),
    );
    assert.strictEqual(
      resolveSkillInjectTargetDirectory("codex", "/home/dev"),
      NodePath.join("/home/dev", ".codex", "skills"),
    );
    assert.strictEqual(
      resolveSkillInjectTargetDirectory("claude", "/home/dev"),
      NodePath.join("/home/dev", ".claude", "skills"),
    );
    assert.strictEqual(
      resolveSkillInjectTargetDirectory("antigravity", "/home/dev"),
      NodePath.join("/home/dev", ".gemini", "config", "skills"),
    );
    assert.strictEqual(
      resolveSkillInjectTargetDirectory("pi", "/home/dev"),
      NodePath.join("/home/dev", ".pi", "agent", "skills"),
    );
  });

  it.live("lists, bundles, and injects skills into target provider directories", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-skill-lib-"));
      try {
        const sourceHome = NodePath.join(root, "source-home");
        const targetHome = NodePath.join(root, "target-home");
        const libDir = NodePath.join(sourceHome, ".t3", "skills");
        NodeFS.mkdirSync(NodePath.join(libDir, "spec-design", "references"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(libDir, "spec-design", "SKILL.md"),
          "---\nname: spec-design\ndescription: Design specs cleanly\n---\n# Spec Design\n",
        );
        NodeFS.writeFileSync(
          NodePath.join(libDir, "spec-design", "references", "checklist.md"),
          "- check 1\n",
        );
        NodeFS.mkdirSync(NodePath.join(libDir, "not-a-skill"), { recursive: true });

        const listed = yield* listSkillLibrary({}).pipe(
          Effect.provideService(HostProcess.HomeDirectory, sourceHome),
        );
        assert.isTrue(listed.exists);
        assert.strictEqual(listed.skills.length, 1);
        assert.strictEqual(listed.skills[0]?.name, "spec-design");
        assert.strictEqual(listed.skills[0]?.description, "Design specs cleanly");
        assert.strictEqual(listed.skills[0]?.filesCount, 2);

        const bundle = yield* readSkillLibraryBundle({ names: ["spec-design"] }).pipe(
          Effect.provideService(HostProcess.HomeDirectory, sourceHome),
        );
        assert.strictEqual(bundle.skills.length, 1);
        assert.strictEqual(bundle.skills[0]?.files.length, 2);

        const injected = yield* injectSkills({
          targets: ["agents", "codex", "antigravity"],
          skills: bundle.skills,
          overwrite: true,
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, targetHome));

        assert.strictEqual(injected.results.length, 3);
        assert.isTrue(injected.results.every((r) => r.status === "injected"));
        assert.strictEqual(
          NodeFS.readFileSync(
            NodePath.join(targetHome, ".gemini", "config", "skills", "spec-design", "SKILL.md"),
            "utf8",
          ),
          "---\nname: spec-design\ndescription: Design specs cleanly\n---\n# Spec Design\n",
        );
        assert.strictEqual(
          NodeFS.readFileSync(
            NodePath.join(
              targetHome,
              ".codex",
              "skills",
              "spec-design",
              "references",
              "checklist.md",
            ),
            "utf8",
          ),
          "- check 1\n",
        );

        const skipped = yield* injectSkills({
          targets: ["codex"],
          skills: bundle.skills,
          overwrite: false,
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, targetHome));
        assert.strictEqual(skipped.results[0]?.status, "skipped");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }),
  );
});
