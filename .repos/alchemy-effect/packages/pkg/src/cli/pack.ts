import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { exec } from "alchemy/Util/exec";
import { sha256 } from "alchemy/Util/sha256";
import { packTar, unpackTar, type TarHeader } from "modern-tar";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  GroupName,
  MANIFEST_FILE,
  ManifestJson,
  type Manifest,
  type ManifestPackage,
} from "../Manifest.ts";
import { manifestArtifactName, tarballUrl } from "../Protocol.ts";

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly message: string;
}> {}

const GROUP_SPEC = /^([^[=]+?)\s*(?:\[([^\]]*)\])?\s*=\s*(.+?)\s*$/;

/**
 * A `--group` flag, `NAME=GLOB` or `NAME[Collapsed]=GLOB`, e.g.
 * `Alchemy=./packages/*` or `Distilled[Collapsed]=./submodules/distilled/packages/*`.
 * `Collapsed` is the only attribute.
 */
export const Group = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({
      name: GroupName,
      pattern: Schema.String,
      /** Render the group collapsed in the install comment. */
      collapsed: Schema.Boolean,
    }),
    SchemaTransformation.transformEffect({
      decode: (spec, options) => {
        const match = spec.match(GROUP_SPEC);
        const attributes = (match?.[2] ?? "")
          .split(",")
          .map((attribute) => attribute.trim())
          .filter((attribute) => attribute.length > 0);
        return match &&
          attributes.every((attribute) => attribute === "Collapsed")
          ? Effect.succeed({
              name: match[1]!,
              pattern: match[3]!,
              collapsed: attributes.includes("Collapsed"),
            })
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                { expected: "NAME=GLOB or NAME[Collapsed]=GLOB" },
                spec,
                options,
              ),
            );
      },
      encode: (group) =>
        Effect.succeed(
          `${group.name}${group.collapsed ? "[Collapsed]" : ""}=${group.pattern}`,
        ),
    }),
  ),
);
export type Group = typeof Group.Type;

/** The subset of `package.json` the CLI reads. Extra keys are preserved on the raw object. */
export const PackageJson = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  private: Schema.optionalKey(Schema.Boolean),
});

export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const DependencyMap = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.String),
);

export const DependencySections = Schema.Struct({
  dependencies: DependencyMap,
  devDependencies: DependencyMap,
  peerDependencies: DependencyMap,
  optionalDependencies: DependencyMap,
});

/**
 * Order packages so every package comes after the packed packages it
 * depends on, grouped into levels that can be packed concurrently. Fails on
 * a cycle, since a tarball cannot link to a dependency that links back.
 */
export const dependencyLevels = Effect.fn("dependencyLevels")(function* (
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const remaining = new Map(
    [...dependencies].map(([name, deps]) => [
      name,
      new Set([...deps].filter((dep) => dependencies.has(dep))),
    ]),
  );
  const levels: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      return yield* new WorkspaceError({
        message: `Dependency cycle among packed packages: ${[...remaining.keys()].sort().join(", ")}`,
      });
    }
    for (const name of ready) remaining.delete(name);
    for (const deps of remaining.values()) {
      for (const name of ready) deps.delete(name);
    }
    levels.push(ready);
  }
  return levels;
});

export interface WorkspacePackage {
  readonly name: string;
  readonly version: string;
  /** Relative to the workspace root, POSIX separators. */
  readonly dir: string;
  readonly absDir: string;
  readonly group: string;
}

/**
 * Expand one level of `{a,b,c}` alternatives into plain patterns, so
 * `./packages/{alchemy,pkg}` lists exactly those two directories.
 */
export const expandBraces = (pattern: string): string[] => {
  const match = pattern.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!match) return [pattern];
  return match[2]!
    .split(",")
    .map((alternative) => alternative.trim())
    .filter((alternative) => alternative.length > 0)
    .flatMap((alternative) =>
      expandBraces(`${match[1]}${alternative}${match[3]}`),
    );
};

/**
 * Expand a directory glob. `*` is supported as a whole path segment and
 * `{a,b}` as a list of alternatives, which covers `./packages/*` and
 * `./submodules/x/packages/{core,aws}`. Matches are directories only.
 */
const expand = Effect.fn("expandGlob")(function* (cwd: string, glob: string) {
  const results: string[] = [];
  for (const pattern of expandBraces(glob)) {
    results.push(...(yield* expandPattern(cwd, pattern)));
  }
  return [...new Set(results)];
});

const expandPattern = Effect.fn("expandPattern")(function* (
  cwd: string,
  pattern: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (pattern.includes("**")) {
    return yield* new WorkspaceError({
      message: `Unsupported pattern ${JSON.stringify(pattern)}: only a single "*" segment is supported`,
    });
  }
  const segments = pattern.split("/").filter((s) => s !== "" && s !== ".");
  let current: string[] = [cwd];
  for (const segment of segments) {
    const next: string[] = [];
    for (const base of current) {
      if (segment === "*") {
        const entries = yield* fs.readDirectory(base);
        for (const entry of entries.sort()) {
          const candidate = path.join(base, entry);
          const stat = yield* fs.stat(candidate);
          if (stat.type === "Directory") next.push(candidate);
        }
      } else if (segment.includes("*")) {
        return yield* new WorkspaceError({
          message: `Unsupported pattern ${JSON.stringify(pattern)}: "*" must be a whole path segment`,
        });
      } else {
        const candidate = path.join(base, segment);
        if (yield* fs.exists(candidate)) next.push(candidate);
      }
    }
    current = next;
  }
  return current;
});

/**
 * Discover publishable packages under each group's pattern, in the order the
 * groups and their directories were given, which is the order they are
 * listed in. Private packages and directories without a named
 * `package.json` are skipped. A package name appearing under two groups is
 * an error.
 */
export const discover = Effect.fn("discoverPackages")(function* (
  cwd: string,
  groups: ReadonlyArray<Group>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson));
  const found = new Map<string, WorkspacePackage>();
  for (const group of groups) {
    for (const absDir of yield* expand(cwd, group.pattern)) {
      const manifestPath = path.join(absDir, "package.json");
      if (!(yield* fs.exists(manifestPath))) continue;
      const manifest = yield* decode(yield* fs.readFileString(manifestPath));
      if (manifest.private || manifest.name === undefined) continue;
      const existing = found.get(manifest.name);
      if (existing !== undefined) {
        return yield* new WorkspaceError({
          message: `Package ${manifest.name} found in both ${existing.dir} and ${path.relative(cwd, absDir)}`,
        });
      }
      found.set(manifest.name, {
        name: manifest.name,
        version: manifest.version ?? "0.0.0",
        dir: path.relative(cwd, absDir).split(path.sep).join("/"),
        absDir,
        group: group.name,
      });
    }
  }
  return [...found.values()];
});

export class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message() {
    return `git ${this.args.join(" ")} in ${this.cwd} exited with ${this.exitCode}: ${this.stderr.trim()}`;
  }
}

/** Run `git` in `cwd` and return trimmed stdout. */
export const git = Effect.fn("git")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  const { exitCode, stdout, stderr } = yield* exec(
    ChildProcess.make("git", [...args], { cwd, shell: false }),
  ).pipe(Effect.scoped);
  if (exitCode !== 0) {
    return yield* new GitError({ args, cwd, exitCode, stderr });
  }
  return stdout.trim();
});

/** Absolute path of the repository (or submodule) that owns `cwd`. */
export const toplevel = (cwd: string) =>
  git(cwd, ["rev-parse", "--show-toplevel"]);

/** Full HEAD SHA of the repository that owns `cwd`. */
const gitHead = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);

export class PackError extends Data.TaggedError("PackError")<{
  readonly dir: string;
  readonly message: string;
}> {}

const PnpmPackOutput = Schema.fromJsonString(
  Schema.Struct({ filename: Schema.String }),
);

/**
 * Rewrite every dependency on a package in `links` to that package's
 * tarball URL. Returns the rewritten manifest text and the rewrites made.
 */
export const rewriteDependencies = (
  manifestText: string,
  links: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.StructWithRest(DependencySections, [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    )(manifestText);
    // Preserve source key order after validation: it contributes to the tarball hash.
    const rewritten = JSON.parse(manifestText);
    const rewrites: Array<{ section: string; name: string; url: string }> = [];
    for (const section of DEPENDENCY_SECTIONS) {
      const deps = manifest[section];
      if (deps === undefined) continue;
      const next: Record<string, string> = { ...deps };
      for (const name of Object.keys(deps)) {
        const url = links.get(name);
        if (url === undefined) continue;
        next[name] = url;
        rewrites.push({ section, name, url });
      }
      rewritten[section] = next;
    }
    return { text: `${JSON.stringify(rewritten, null, 2)}\n`, rewrites };
  });

const EPOCH = new Date(0);

/**
 * Normalize tar headers so identical inputs produce identical bytes:
 * fixed mtime, no ownership, entries sorted by path.
 */
const normalize = (header: TarHeader, size: number): TarHeader => ({
  name: header.name,
  size,
  mode: header.mode,
  type: header.type ?? "file",
  mtime: EPOCH,
  uid: 0,
  gid: 0,
  uname: "",
  gname: "",
  ...(header.linkname !== undefined ? { linkname: header.linkname } : {}),
});

export interface PackedTarball {
  readonly file: string;
  readonly sha256: string;
  readonly size: number;
  readonly rewrites: ReadonlyArray<{
    section: string;
    name: string;
    url: string;
  }>;
}

/**
 * Pack one package with pnpm, rewrite its dependencies on already-packed
 * packages to their tarball URLs, and repack reproducibly into `outDir/file`.
 */
export const packPackage = Effect.fn("packPackage")(function* (options: {
  readonly absDir: string;
  /** Tarball URL of every already-packed dependency, by package name. */
  readonly links: ReadonlyMap<string, string>;
  readonly outDir: string;
  readonly file: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pkg-pack-" });

  const { exitCode, stdout, stderr } = yield* exec(
    ChildProcess.make("pnpm", ["pack", "--json", "--pack-destination", tmp], {
      cwd: options.absDir,
      shell: false,
    }),
  );
  if (exitCode !== 0) {
    return yield* new PackError({
      dir: options.absDir,
      message: `pnpm pack exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`,
    });
  }
  // pnpm may print progress lines before the JSON document.
  const json = stdout.slice(stdout.indexOf("{"));
  const { filename } = yield* Schema.decodeUnknownEffect(PnpmPackOutput)(json);

  const packed = yield* fs.readFile(path.join(tmp, path.basename(filename)));
  const inflated = yield* Effect.sync(() => gunzipSync(packed));
  const entries = yield* Effect.promise(() => unpackTar(inflated));

  let rewrites: PackedTarball["rewrites"] = [];
  const normalized: Array<{ header: TarHeader; data: Uint8Array }> = [];
  for (const entry of entries.sort((a, b) =>
    a.header.name.localeCompare(b.header.name),
  )) {
    let data = entry.data ?? new Uint8Array();
    if (entry.header.name === "package/package.json") {
      const text = yield* Effect.sync(() => new TextDecoder().decode(data));
      const result = yield* rewriteDependencies(text, options.links).pipe(
        Effect.mapError(
          (e) => new PackError({ dir: options.absDir, message: String(e) }),
        ),
      );
      rewrites = result.rewrites;
      data = yield* Effect.sync(() => new TextEncoder().encode(result.text));
    }
    normalized.push({ header: normalize(entry.header, data.byteLength), data });
  }

  const tar = yield* Effect.promise(() => packTar(normalized));
  const bytes = yield* Effect.sync(() => gzipSync(tar, { level: 9 }));
  yield* fs.writeFile(path.join(options.outDir, options.file), bytes);
  return {
    file: options.file,
    sha256: yield* sha256(bytes),
    size: bytes.byteLength,
    rewrites,
  } satisfies PackedTarball;
});

const PullRequestEvent = Schema.fromJsonString(
  Schema.Struct({
    pull_request: Schema.optionalKey(
      Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) }),
    ),
  }),
);

/**
 * The pull request head commit when running under a GitHub Actions
 * `pull_request` event, read from the event payload. `undefined` elsewhere.
 * On that event the default checkout is a synthetic merge commit, which the
 * registry would reject because it does not match the run's head.
 */
const pullRequestHead = Effect.gen(function* () {
  const event = yield* Config.option(Config.String("GITHUB_EVENT_NAME"));
  const eventPath = yield* Config.option(Config.String("GITHUB_EVENT_PATH"));
  if (
    Option.getOrUndefined(event) !== "pull_request" ||
    Option.isNone(eventPath)
  ) {
    return undefined;
  }
  const fs = yield* FileSystem.FileSystem;
  const payload = yield* fs
    .readFileString(eventPath.value)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(PullRequestEvent)));
  return payload.pull_request?.head.sha;
});

export interface PackOptions {
  readonly cwd: string;
  readonly groups: ReadonlyArray<Group>;
  readonly registry: string;
  readonly out: string;
}

/**
 * Tarball file name for a package: `@` dropped and the scope separator
 * replaced by `+`, a character package names cannot contain, so `@a/b-c`
 * and `@a-b/c` get distinct files.
 */
export const tarballFile = (name: string) =>
  `${name.replace(/^@/, "").replace("/", "+")}.tgz`;

/**
 * Pack every discovered package into `out` with a manifest describing each
 * tarball. Nothing here talks to the registry.
 */
export const pack = Effect.fn("pack")(function* (options: PackOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = yield* toplevel(options.cwd);
  const head = yield* gitHead(root);
  const prHead = yield* pullRequestHead;
  if (prHead !== undefined && prHead !== head) {
    return yield* new WorkspaceError({
      message:
        `HEAD is ${head} but the pull request head is ${prHead}. ` +
        "Check out github.event.pull_request.head.sha before packing so tarballs are addressed by a commit that exists on the pull request.",
    });
  }
  const packages = yield* discover(options.cwd, options.groups);
  if (packages.length === 0) {
    yield* Console.log("No publishable packages matched.");
    return undefined;
  }

  // Dependencies between packed packages are rewritten to the dependency's
  // immutable tarball URL, so a package is packed only after everything it
  // depends on has a hash.
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const dependencies = new Map<string, Set<string>>();
  for (const pkg of packages) {
    const manifest = yield* fs
      .readFileString(path.join(pkg.absDir, "package.json"))
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.fromJsonString(DependencySections)),
        ),
      );
    dependencies.set(
      pkg.name,
      new Set(
        DEPENDENCY_SECTIONS.flatMap((section) =>
          Object.keys(manifest[section] ?? {}),
        ).filter((name) => name !== pkg.name && byName.has(name)),
      ),
    );
  }
  const levels = yield* dependencyLevels(dependencies);

  // The output directory is replaced wholesale, so it has to be a proper
  // subdirectory of the workspace: `--out .` would otherwise delete it.
  const outDir = path.resolve(options.cwd, options.out);
  const relative = path.relative(options.cwd, outDir);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    return yield* new WorkspaceError({
      message: `--out must be a subdirectory of ${options.cwd}, got ${outDir}`,
    });
  }
  yield* fs.remove(outDir, { recursive: true, force: true });
  yield* fs.makeDirectory(outDir, { recursive: true });

  const links = new Map<string, string>();
  const packedByName = new Map<string, ManifestPackage>();
  for (const level of levels) {
    const packedLevel = yield* Effect.forEach(
      level,
      Effect.fn(function* (name) {
        const pkg = byName.get(name)!;
        const packed = yield* packPackage({
          absDir: pkg.absDir,
          links,
          outDir,
          file: tarballFile(pkg.name),
        }).pipe(Effect.scoped);
        const lines = [
          `${pkg.name}@${pkg.version} ${packed.sha256.slice(0, 12)} ${packed.size} bytes`,
          ...packed.rewrites.map((r) => `  ${r.section}.${r.name} -> ${r.url}`),
        ];
        yield* Console.log(lines.join("\n"));
        return {
          name: pkg.name,
          version: pkg.version,
          dir: pkg.dir,
          group: pkg.group,
          file: packed.file,
          sha256: packed.sha256,
          size: packed.size,
        } satisfies ManifestPackage;
      }),
      { concurrency: 4 },
    );
    for (const entry of packedLevel) {
      links.set(
        entry.name,
        tarballUrl(options.registry, entry.name, entry.sha256),
      );
      packedByName.set(entry.name, entry);
    }
  }
  // Packing ran in dependency order; the manifest keeps the listed order.
  const entries = packages.map((pkg) => packedByName.get(pkg.name)!);

  // One entry per distinct group name, in the order the groups were given.
  const groups = [
    ...new Map(
      options.groups.map((group) => [
        group.name,
        { name: group.name, collapsed: group.collapsed },
      ]),
    ).values(),
  ];
  const manifest: Manifest = {
    version: 1,
    groups,
    registry: options.registry.replace(/\/+$/, ""),
    head,
    packages: entries,
  };
  const manifestText = `${yield* Schema.encodeEffect(ManifestJson)(manifest)}\n`;
  yield* fs.writeFileString(path.join(outDir, MANIFEST_FILE), manifestText);
  yield* Console.log(
    `Packed ${entries.length} package(s) into ${path.relative(options.cwd, outDir) || "."}`,
  );

  // The workflow uploads the manifest as an artifact under this name; that
  // upload is what proves to the registry that this run vouched for it.
  // Only a JavaScript action receives the runtime token needed to upload,
  // so the CLI cannot do it itself.
  const artifact = manifestArtifactName(yield* sha256(manifestText));
  const stepOutput = yield* Config.option(Config.String("GITHUB_OUTPUT"));
  if (Option.isSome(stepOutput)) {
    yield* fs.writeFileString(stepOutput.value, `artifact-name=${artifact}\n`, {
      flag: "a",
    });
  }
  yield* Console.log(`Manifest artifact name: ${artifact}`);
  return manifest;
});
