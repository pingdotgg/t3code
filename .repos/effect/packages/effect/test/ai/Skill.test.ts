import { assert, describe, it } from "@effect/vitest"
import * as Skill from "effect/ai/Skill"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("Skill", () => {
  it("validates frontmatter and file paths on construction", () => {
    const skill = Skill.make({
      frontmatter: { name: "refunds", description: "Process customer refunds" },
      instructions: "Read references/policy.md before issuing a refund."
    })
    assert.instanceOf(skill, Skill.Skill)
    assert.deepStrictEqual(skill.files, {})

    assert.throws(() =>
      Skill.make({
        frontmatter: { name: "Bad_Name", description: "Process customer refunds" },
        instructions: ""
      })
    )

    assert.throws(() =>
      Skill.make({
        frontmatter: { name: "refunds", description: "Process customer refunds", revision: 1n as any },
        instructions: ""
      })
    )

    for (const path of ["../secret.txt", "C:/notes.txt", "SKILL.md"]) {
      assert.throws(() =>
        Skill.make({
          frontmatter: { name: "refunds", description: "Process customer refunds" },
          instructions: "",
          files: { [path]: "secret" }
        })
      )
    }
  })

  it.effect("round-trips through toFiles and fromFiles, and rejects invalid file bundles", () =>
    Effect.gen(function*() {
      const inputFiles: Record<string, string | Uint8Array> = {
        "references/policy.md": "Refunds over $100 require approval.",
        "assets/logo.png": PNG
      }
      Object.defineProperty(inputFiles, "__proto__", {
        value: "proto-file",
        enumerable: true,
        writable: true,
        configurable: true
      })
      const skill = Skill.make({
        frontmatter: {
          name: "refunds",
          description: "yes: it's #1",
          metadata: { version: "1.0" },
          "#note": "retain"
        },
        instructions: "Read references/policy.md before issuing a refund.",
        files: inputFiles
      })

      const roundTripped = yield* Skill.fromFiles(Skill.toFiles(skill))
      assert.deepStrictEqual(roundTripped, skill)
      assert.isTrue(Object.hasOwn(roundTripped.files, "__proto__"))

      const missingSkillMd = yield* Effect.flip(Skill.fromFiles({ "references/policy.md": "orphan" }))
      assert.isTrue(Cause.isIllegalArgumentError(missingSkillMd))

      const badFrontmatter = yield* Effect.flip(
        Skill.fromFiles({ "SKILL.md": "---\nname: Bad_Name\ndescription: bad\n---\n\nBody" })
      )
      assert.isTrue(Cause.isIllegalArgumentError(badFrontmatter))
    }))

  it.effect("round-trips text and binary files through JSON", () =>
    Effect.gen(function*() {
      const skill = Skill.make({
        frontmatter: { name: "refunds", description: "Process customer refunds" },
        instructions: "Read references/policy.md before issuing a refund.",
        files: {
          "references/policy.md": "Refunds over $100 require approval.",
          "assets/logo.png": PNG
        }
      })

      const codec = Schema.fromJsonString(Schema.toCodecJson(Skill.Skill))
      const encoded = yield* Schema.encodeEffect(codec)(skill)
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded)

      assert.instanceOf(decoded, Skill.Skill)
      assert.instanceOf(decoded.files["assets/logo.png"], Uint8Array)
      assert.deepStrictEqual(decoded, skill)
    }))
})
