/**
 * Standalone Agent Skill value and schema for local agents and MCP servers.
 *
 * A `Skill` models an Agent Skill (https://agentskills.io/specification) as
 * plain data — validated YAML `frontmatter`, markdown `instructions`, and
 * supporting `files` — with `SKILL.md` as its serialization format via
 * {@link toFiles} and {@link fromFiles}.
 *
 * @stability unstable
 * @since 4.1.6
 */
import * as Cause from "../Cause.ts"
import * as Effect from "../Effect.ts"
import * as Yaml from "../encoding/Yaml.ts"
import * as Predicate from "../Predicate.ts"
import * as Schema from "../Schema.ts"
import * as SchemaTransformation from "../SchemaTransformation.ts"

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Schema for the YAML frontmatter of an Agent Skill's `SKILL.md`, as the
 * Agent Skills specification defines it (https://agentskills.io/specification).
 *
 * **Details**
 *
 * Fields the specification does not define are kept unchanged.
 *
 * @stability unstable
 * @category schemas
 * @since 4.1.6
 */
export const Frontmatter = Schema.StructWithRest(
  Schema.Struct({
    /**
     * 1 to 64 lowercase letters, digits and hyphens, with no leading, trailing
     * or consecutive hyphen. It names the directory holding `SKILL.md`.
     */
    name: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(SKILL_NAME)),
    /**
     * What the skill does and when to use it, in 1 to 1024 characters.
     */
    description: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
    /**
     * The skill's license, or the name of a bundled license file.
     */
    license: Schema.optionalKey(Schema.String),
    /**
     * Environment requirements, in 1 to 500 characters.
     */
    compatibility: Schema.optionalKey(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500))),
    /**
     * Additional properties not defined by the specification.
     */
    metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    /**
     * Space-separated tools the skill asks to run without approval. Hosts must
     * ignore it for a skill served over MCP unless the user approved the grant.
     */
    "allowed-tools": Schema.optionalKey(Schema.String)
  }),
  [Schema.JsonObject]
)

/**
 * The YAML frontmatter of an Agent Skill's `SKILL.md`.
 *
 * @stability unstable
 * @category models
 * @since 4.1.6
 */
export type Frontmatter = typeof Frontmatter.Type

const isSafeSkillFilePath = (path: string): boolean =>
  path !== "" &&
  path !== "SKILL.md" &&
  !path.includes("\\") &&
  !/^[A-Za-z]:/.test(path) &&
  path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")

const Bytes = Schema.Uint8Array.annotate({
  toCodecJson: () =>
    Schema.link<Uint8Array<ArrayBufferLike>>()(
      Schema.Struct({ base64: Schema.Uint8ArrayFromBase64 }),
      SchemaTransformation.transform({
        decode: ({ base64 }) => base64,
        encode: (base64) => ({ base64 })
      })
    )
})

const SkillFiles = Schema.Record(Schema.String, Schema.Union([Schema.String, Bytes])).check(
  Schema.makeFilter((files) => {
    const path = Object.keys(files).find((path) => !isSafeSkillFilePath(path))
    return path === undefined || `Invalid skill file path "${path}"`
  })
)

/**
 * Schema and class for an Agent Skill bundle.
 *
 * **Details**
 *
 * Holds validated {@link Frontmatter}, markdown `instructions`, and supporting
 * `files` keyed by safe relative paths (excluding `SKILL.md`). When encoded
 * with `Schema.toCodecJson`, binary `Uint8Array` files are represented as
 * `{ base64: string }` so text and binary files stay distinct.
 *
 * @see {@link make} for constructing a skill
 * @see {@link toFiles} for rendering a skill to a file map including `SKILL.md`
 * @see {@link fromFiles} for parsing a skill from a file map containing `SKILL.md`
 *
 * @stability unstable
 * @category models
 * @since 4.1.6
 */
export class Skill extends Schema.Class<Skill>("effect/ai/Skill")({
  frontmatter: Frontmatter,
  instructions: Schema.String,
  files: SkillFiles
}) {}

/**
 * Constructs a validated {@link Skill}.
 *
 * **Gotchas**
 *
 * Throws an `Error` (with the validation issue on `cause`) when `frontmatter`
 * fails validation or any key in `files` is `"SKILL.md"` or an unsafe path.
 * Use {@link fromFiles} or `Schema.decodeUnknownEffect(Skill)` for untrusted input.
 *
 * @see {@link fromFiles} for effectful construction from a raw file map
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.6
 */
export const make = (options: {
  readonly frontmatter: Frontmatter
  readonly instructions: string
  readonly files?: Readonly<Record<string, string | Uint8Array>> | undefined
}): Skill => new Skill({ ...options, files: options.files ?? {} })

/**
 * Renders a {@link Skill} into a file map that includes the generated
 * `SKILL.md` along with all supporting files.
 *
 * **Details**
 *
 * Frontmatter keys and values are JSON-encoded so YAML edge cases round-trip
 * cleanly through {@link fromFiles}.
 *
 * @see {@link fromFiles} for parsing a file map back into a {@link Skill}
 *
 * @stability unstable
 * @category conversions
 * @since 4.1.6
 */
export const toFiles = (
  self: Skill
): { readonly "SKILL.md": string } & Readonly<Record<string, string | Uint8Array>> => {
  const frontmatter = Object.entries(self.frontmatter)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join("\n")
  return { "SKILL.md": `---\n${frontmatter}\n---\n\n${self.instructions}`, ...self.files }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const decodeUtf8 = (content: Uint8Array): string | undefined => {
  try {
    return utf8.decode(content)
  } catch {
    return undefined
  }
}

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const parseSkillMarkdown = (
  markdown: string
): { readonly frontmatter: Record<string, unknown>; readonly instructions: string } | undefined => {
  const match = FRONTMATTER.exec(markdown)
  if (match === null) return undefined
  try {
    const parsed = Yaml.parse(match[1])
    if (!Predicate.isObject(parsed)) return undefined
    // Keep only JSON values so `.inf` and `.nan` normalize to `null`.
    const frontmatter: Record<string, unknown> = JSON.parse(JSON.stringify(parsed))
    const instructions = markdown.slice(match[0].length).replace(/^\r?\n/, "")
    return { frontmatter, instructions }
  } catch {
    return undefined
  }
}

const decodeSkill = Schema.decodeUnknownEffect(Skill)

/**
 * Parses a {@link Skill} from a file map containing `SKILL.md` and optional
 * supporting files.
 *
 * **Details**
 *
 * Fails with `Cause.IllegalArgumentError` when `SKILL.md` is missing, not
 * valid UTF-8, lacks a valid YAML frontmatter block, or fails {@link Skill}
 * schema validation.
 *
 * @see {@link toFiles} for the inverse conversion
 * @see {@link make} for constructing a skill from structured fields
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.6
 */
export const fromFiles = (
  files: Readonly<Record<string, string | Uint8Array>>
): Effect.Effect<Skill, Cause.IllegalArgumentError> =>
  Effect.suspend(() => {
    // Rest destructuring defines own properties, so a file named `__proto__` survives.
    const { "SKILL.md": skillMd, ...supportingFiles } = files
    if (skillMd === undefined) {
      return Effect.fail(new Cause.IllegalArgumentError("Skill is missing SKILL.md"))
    }
    const markdown = typeof skillMd === "string" ? skillMd : decodeUtf8(skillMd)
    if (markdown === undefined) {
      return Effect.fail(new Cause.IllegalArgumentError("SKILL.md is not valid UTF-8"))
    }
    const parsed = parseSkillMarkdown(markdown)
    if (parsed === undefined) {
      return Effect.fail(new Cause.IllegalArgumentError("SKILL.md is missing valid YAML frontmatter"))
    }
    return decodeSkill({ ...parsed, files: supportingFiles }).pipe(
      Effect.mapError((error) => new Cause.IllegalArgumentError(error.message))
    )
  })
