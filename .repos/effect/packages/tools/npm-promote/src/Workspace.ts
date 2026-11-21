import * as Effect from "effect/Effect"
import * as Yaml from "effect/encoding/Yaml"
import * as Option from "effect/Option"
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Schema from "effect/Schema"
import * as Semver from "semver"
import type { ReleasePackage } from "./NpmPromote.ts"
import { NpmPromoteError } from "./NpmPromoteError.ts"
import * as Process from "./Process.ts"

export interface WorkspacePackage extends ReleasePackage {
  readonly directory: string
}

const PnpmList = Schema.fromJsonString(Schema.Array(Schema.Struct({
  name: Schema.optional(Schema.NullOr(Schema.String)),
  version: Schema.optional(Schema.NullOr(Schema.String)),
  path: Schema.String,
  private: Schema.optional(Schema.Boolean)
})))

/**
 * Lists the non-private workspace packages with their versions at the
 * checked-out revision. These are the packages `changeset publish` releases.
 */
export const releasePackages = (
  cwd: string
): Effect.Effect<ReadonlyArray<WorkspacePackage>, NpmPromoteError, ChildProcessSpawner.ChildProcessSpawner> =>
  Process.run("pnpm", ["ls", "--recursive", "--depth", "-1", "--json"], { cwd }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PnpmList)),
    Effect.mapError((cause) =>
      Schema.is(NpmPromoteError)(cause) ? cause : new NpmPromoteError({
        message: "Could not read the pnpm workspace package list",
        cause
      })
    ),
    Effect.map((packages) =>
      packages.flatMap((pkg) =>
        pkg.private !== true && typeof pkg.name === "string" && typeof pkg.version === "string"
          ? [{ name: pkg.name, version: pkg.version, directory: pkg.path }]
          : []
      )
    )
  )

const WorkspaceConfig = Schema.Struct({ packages: Schema.Array(Schema.String) })

const Manifest = Schema.fromJsonString(Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  private: Schema.optional(Schema.Boolean)
}))

/** Reads the release's public workspace package set and its exact targets without checking out or running historical code. */
export const packagesAtBump = (
  cwd: string,
  revision: string,
  effectVersion: string
): Effect.Effect<ReadonlyArray<ReleasePackage>, NpmPromoteError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const read = (path: string) => Process.run("git", ["cat-file", "blob", `${revision}:${path}`], { cwd })
    const source = yield* read("pnpm-workspace.yaml")
    const { packages: patterns } = yield* Effect.try(() =>
      Schema.decodeUnknownSync(WorkspaceConfig)(Yaml.parse(source))
    )
    // Support literal path components and single-component wildcards. Never silently
    // misinterpret an exclusion or a more complex pnpm glob as a missing package.
    for (const pattern of patterns) {
      if (!pattern.split("/").every((part) => part === "*" || /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))) {
        return yield* new NpmPromoteError({
          message: `Unsupported workspace package pattern at ${revision}: ${pattern}`
        })
      }
    }
    const tree = yield* Process.run("git", ["ls-tree", "-rz", "--name-only", revision], { cwd })
    // A `*` component matches one directory name that does not start with a dot.
    const matches = (directory: ReadonlyArray<string>, pattern: string) => {
      const parts = pattern.split("/")
      return parts.length === directory.length &&
        parts.every((part, i) => part === "*" ? !directory[i].startsWith(".") : part === directory[i])
    }
    const paths = tree.split("\0").filter((path) => {
      const directory = path.split("/").slice(0, -1)
      return path === "package.json" ||
        (path.endsWith("/package.json") && patterns.some((pattern) => matches(directory, pattern)))
    })
    const manifests = yield* Effect.forEach(paths, (path) =>
      read(path).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Manifest))
      ), { concurrency: 8 })

    const packages: Array<ReleasePackage> = []
    for (const pkg of manifests) {
      if (pkg.private === true) continue
      if (!pkg.name || !pkg.version || !Semver.valid(pkg.version)) {
        return yield* new NpmPromoteError({
          message: `Unverified public manifest at ${revision}: ${pkg.name ?? "(unnamed)"}`
        })
      }
      packages.push({ name: pkg.name, version: pkg.version })
    }
    if (!packages.some((pkg) => pkg.name === "effect" && pkg.version === effectVersion)) {
      return yield* new NpmPromoteError({
        message: `Could not verify the workspace package set for effect@${effectVersion} at ${revision}`
      })
    }
    return packages
  }).pipe(Effect.mapError((cause) =>
    Schema.is(NpmPromoteError)(cause) ? cause : new NpmPromoteError({
      message: `Could not read package registrations or manifests at ${revision}`,
      cause
    })
  ))

export interface VersionBump {
  readonly sha: string
  readonly committedAt: Date
}

/**
 * Finds the newest commit that changed the `version` field of the package in
 * `directory`. Fails in a shallow clone, which would report its boundary
 * commit instead.
 */
export const versionBump = (
  directory: string
): Effect.Effect<Option.Option<VersionBump>, NpmPromoteError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const shallow = yield* Process.run("git", ["rev-parse", "--is-shallow-repository"], { cwd: directory })
    if (shallow.trim() !== "false") {
      return yield* new NpmPromoteError({ message: "Finding the version bump commit needs a full clone" })
    }
    return yield* Process.run("git", ["log", "-1", "--format=%H %cI", "-G", "\"version\":", "--", "package.json"], {
      cwd: directory
    })
  }).pipe(
    Effect.map((output) => {
      const [sha, committedAt] = output.trim().split(" ")
      return sha && committedAt ? Option.some({ sha, committedAt: new Date(committedAt) }) : Option.none()
    })
  )
