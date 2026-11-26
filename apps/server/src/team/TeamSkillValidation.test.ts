import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { validateTeamPrepromptPayload, validateTeamSkillPayload } from "./TeamSkillValidation.ts";

const VALID_SKILL_MD = `---
name: pr-review
description: Run the team PR review checklist.
---

# PR Review Checklist

Check tests, types, and security invariants.
`;

describe("TeamSkillValidation", () => {
  it.effect(
    "accepts pure Markdown SKILL.md with valid YAML frontmatter and Markdown/text references",
    () =>
      Effect.gen(function* () {
        const result = yield* validateTeamSkillPayload({
          slug: "PR-Review",
          providerDriver: "*",
          skillMd: VALID_SKILL_MD,
          references: [
            { path: "references/checklist.md", content: "# Checklist\n- Verify tests\n" },
            { path: "notes/schema.json", content: '{"ok":true}\n' },
          ],
        });

        expect(result.slug).toBe("pr-review");
        expect(result.references).toHaveLength(2);
        expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
      }),
  );

  it.effect(
    "rejects executable script references (.sh, .py, .js, .ts) as a strict security boundary",
    () =>
      Effect.gen(function* () {
        for (const badPath of [
          "scripts/run.sh",
          "scripts/helper.py",
          "scripts/tool.js",
          "scripts/tool.ts",
          "bin/evil.exe",
        ]) {
          const result = yield* Effect.result(
            validateTeamSkillPayload({
              slug: "bad-exec",
              providerDriver: "*",
              skillMd: VALID_SKILL_MD,
              references: [{ path: badPath, content: "echo hi" }],
            }),
          );
          expect(result._tag).toBe("Failure");
        }
      }),
  );

  it.effect("rejects shebangs (#!) even inside .md or .txt files", () =>
    Effect.gen(function* () {
      const inRef = yield* Effect.result(
        validateTeamSkillPayload({
          slug: "shebang-ref",
          providerDriver: "*",
          skillMd: VALID_SKILL_MD,
          references: [{ path: "references/tricky.md", content: "#!/bin/bash\nrm -rf /\n" }],
        }),
      );
      expect(inRef._tag).toBe("Failure");

      const inSkillMd = yield* Effect.result(
        validateTeamSkillPayload({
          slug: "shebang-md",
          providerDriver: "*",
          skillMd: "#!/usr/bin/env sh\n---\nname: x\n---\n",
        }),
      );
      expect(inSkillMd._tag).toBe("Failure");
    }),
  );

  it.effect("rejects path traversal and absolute reference paths", () =>
    Effect.gen(function* () {
      for (const badPath of [
        "../outside.md",
        "references/../../etc/passwd.txt",
        "/etc/hosts.txt",
        "references\\windows.md",
        "SKILL.md",
      ]) {
        const result = yield* Effect.result(
          validateTeamSkillPayload({
            slug: "bad-path",
            providerDriver: "*",
            skillMd: VALID_SKILL_MD,
            references: [{ path: badPath, content: "hello" }],
          }),
        );
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("rejects binary NUL bytes and missing YAML frontmatter", () =>
    Effect.gen(function* () {
      const noFrontmatter = yield* Effect.result(
        validateTeamSkillPayload({
          slug: "no-fm",
          providerDriver: ProviderDriverKind.make("codex"),
          skillMd: "# Just markdown without frontmatter",
        }),
      );
      expect(noFrontmatter._tag).toBe("Failure");

      const binaryBytes = yield* Effect.result(
        validateTeamSkillPayload({
          slug: "bin-ref",
          providerDriver: "*",
          skillMd: VALID_SKILL_MD,
          references: [{ path: "notes.txt", content: "abc\u0000def" }],
        }),
      );
      expect(binaryBytes._tag).toBe("Failure");
    }),
  );

  it.effect("validates team pre-prompts and rejects empty or binary content", () =>
    Effect.gen(function* () {
      const ok = yield* validateTeamPrepromptPayload({
        name: "  Security Rules  ",
        providerDriver: "*",
        content: "Never commit API keys.",
      });
      expect(ok.name).toBe("Security Rules");
      expect(ok.contentHash).toMatch(/^[a-f0-9]{64}$/);

      const empty = yield* Effect.result(
        validateTeamPrepromptPayload({
          name: "Empty",
          providerDriver: "*",
          content: "   ",
        }),
      );
      expect(empty._tag).toBe("Failure");
    }),
  );
});
