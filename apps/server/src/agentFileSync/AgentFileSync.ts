// @effect-diagnostics nodeBuiltinImport:off -- Node crypto hashes bounded file snapshots; filesystem access uses the injected service.
import * as NodeCrypto from "node:crypto";
import {
  AgentFileSyncError,
  AgentFileSyncFile,
  AgentFileSyncScope,
  AgentFileSyncBundle,
  type AgentFileSyncApplyInput,
  type AgentFileSyncApplyResult,
  type AgentFileSyncCatalog,
  type AgentFileSyncExportInput,
  type AgentFileSyncPreview,
  type AgentFileSyncPreviewInput,
  type AgentFileSyncResource,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import { instructionSections, mergeInstructionSection } from "./instructions.ts";

const SKILL_ROOTS = [
  ".agents/skills",
  ".codex/skills",
  ".claude/skills",
  ".cursor/skills",
  ".grok/skills",
  ".opencode/skills",
  ".config/opencode/skills",
  ".pi/agent/skills",
  ".gemini/config/skills",
  ".gemini/antigravity-cli/skills",
];
const PROJECT_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const PERSONAL_INSTRUCTIONS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".agents/AGENTS.md",
  ".codex/AGENTS.md",
  ".claude/CLAUDE.md",
  ".config/opencode/AGENTS.md",
];
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_DEPTH = 12;
const Snapshot = Schema.NullOr(Schema.Array(AgentFileSyncFile));
type Snapshot = typeof Snapshot.Type;
const Receipt = Schema.Struct({
  scope: AgentFileSyncScope,
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["skill", "instructions"]),
      before: Snapshot,
      after: Schema.String,
    }),
  ),
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Receipt));
const encodeBundle = Schema.encodeSync(Schema.fromJsonString(AgentFileSyncBundle));
const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Receipt));
const isSyncError = Schema.is(AgentFileSyncError);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const revision = (files: Snapshot) =>
  files === null
    ? null
    : hash(
        [...files]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((file) => `${file.path}\0${file.mode}\0${file.data}`)
          .join("\0"),
      );
const validPart = (part: string) =>
  /^[a-zA-Z0-9._@][a-zA-Z0-9._@+ -]*$/.test(part) &&
  part !== "." &&
  part !== ".." &&
  part.toLowerCase() !== ".git" &&
  !part.endsWith(".") &&
  !part.endsWith(" ") &&
  !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part);
const safeRelative = (name: string) => name.split("/").every(validPart);

export class AgentFileSync extends Context.Service<
  AgentFileSync,
  {
    readonly list: (
      scope: AgentFileSyncScope,
    ) => Effect.Effect<AgentFileSyncCatalog, AgentFileSyncError>;
    readonly check: (input: {
      readonly selection: AgentFileSyncExportInput;
      readonly revision: string;
    }) => Effect.Effect<{ bundle: AgentFileSyncBundle | null }, AgentFileSyncError>;
    readonly export: (
      input: AgentFileSyncExportInput,
    ) => Effect.Effect<AgentFileSyncBundle, AgentFileSyncError>;
    readonly preview: (
      input: AgentFileSyncPreviewInput,
      previous?: AgentFileSyncBundle,
    ) => Effect.Effect<AgentFileSyncPreview, AgentFileSyncError>;
    readonly apply: <E = never, R = never>(
      input: AgentFileSyncApplyInput,
      history?: boolean,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<AgentFileSyncApplyResult, AgentFileSyncError | E, R>;
    readonly reconcile: (
      input: AgentFileSyncPreviewInput & { readonly previous: AgentFileSyncBundle },
    ) => Effect.Effect<void, AgentFileSyncError>;
    readonly undo: (input: {
      readonly undoId: string;
    }) => Effect.Effect<AgentFileSyncApplyResult, AgentFileSyncError>;
    readonly discard: (input: {
      readonly undoId: string;
    }) => Effect.Effect<void, AgentFileSyncError>;
  }
>()("t3/agentFileSync/AgentFileSync") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  // Windows only persists the writable bit; comparing Unix executable bits would pause every sync.
  const destinationFiles = (files: readonly AgentFileSyncFile[]) =>
    files.map((file) => ({
      ...file,
      mode: platform === "win32" ? (file.mode & 0o200 ? 0o666 : 0o444) : file.mode,
    }));
  const known = yield* KnownWorkspaces.KnownWorkspaces;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const receiptDirectory = path.join(config.stateDir, "agent-file-sync");
  const io = <A, E, R>(effect: Effect.Effect<A, E, R>, at: string) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isSyncError(cause) ? cause : new AgentFileSyncError({ reason: "io", path: at, cause }),
      ),
    );
  const root = Effect.fn("AgentFileSync.root")(function* (scope: AgentFileSyncScope) {
    if (scope.cwd) yield* io(known.assertContains(scope.cwd), scope.cwd);
    return yield* io(fs.realPath(scope.cwd ?? home), scope.cwd ?? home);
  });
  const validResource = (scope: AgentFileSyncScope, at: string, kind: "skill" | "instructions") => {
    const valid =
      kind === "instructions"
        ? (scope.cwd ? PROJECT_INSTRUCTIONS : PERSONAL_INSTRUCTIONS).includes(at)
        : SKILL_ROOTS.some(
            (directory) =>
              at.startsWith(`${directory}/`) &&
              validPart(at.slice(directory.length + 1)) &&
              !at.slice(directory.length + 1).includes("/"),
          );
    return valid
      ? Effect.void
      : Effect.fail(new AgentFileSyncError({ reason: "invalid-path", path: at }));
  };
  // realPath detects linked ancestors too; writes must never follow a link to another host's local source.
  const assertUnlinked = Effect.fn("AgentFileSync.assertUnlinked")(function* (
    base: string,
    relative: string,
  ) {
    let current = base;
    for (const part of relative.split("/")) {
      current = path.join(current, part);
      const resolved = yield* io(
        fs.realPath(current).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
          }),
        ),
        relative,
      );
      if (resolved !== null && path.relative(current, resolved) !== "")
        return yield* new AgentFileSyncError({ reason: "linked-destination", path: relative });
      // A dangling link has no realPath, but still occupies a directory entry.
      if (resolved === null) {
        const entries = yield* io(
          fs.readDirectory(path.dirname(current)).pipe(
            Effect.catchTags({
              PlatformError: (error) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed<readonly string[]>([])
                  : Effect.fail(error),
            }),
          ),
          relative,
        );
        if (entries.includes(part))
          return yield* new AgentFileSyncError({ reason: "linked-destination", path: relative });
        break;
      }
    }
  });
  const readSnapshot = Effect.fn("AgentFileSync.readSnapshot")(function* (
    base: string,
    at: string,
    kind: "skill" | "instructions",
    forWrite = false,
  ) {
    if (forWrite) yield* assertUnlinked(base, at);
    const absolute = path.join(base, at);
    const resolved = yield* io(
      fs.realPath(absolute).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
        }),
      ),
      at,
    );
    if (resolved === null) return null;
    const files: AgentFileSyncFile[] = [];
    let bytes = 0;
    const visit = Effect.fn("AgentFileSync.readEntry")(function* (
      entry: string,
      relative: string,
      depth: number,
    ): Effect.fn.Return<void, AgentFileSyncError> {
      if (depth > MAX_SKILL_DEPTH)
        return yield* new AgentFileSyncError({ reason: "limit", path: at });
      const real = yield* io(fs.realPath(entry), at);
      if (path.relative(entry, real) !== "")
        return yield* new AgentFileSyncError({ reason: "linked-destination", path: at });
      const info = yield* io(fs.stat(entry), at);
      if (info.type === "Directory" && kind === "skill") {
        const entries = (yield* io(fs.readDirectory(entry), at)).sort();
        for (const name of entries) {
          if (!validPart(name))
            return yield* new AgentFileSyncError({ reason: "invalid-path", path: at });
          yield* visit(path.join(entry, name), relative ? `${relative}/${name}` : name, depth + 1);
        }
      } else if (info.type === "File" && (kind === "instructions" || relative)) {
        if (files.length >= 256 || Number(info.size) > MAX_FILE_BYTES)
          return yield* new AgentFileSyncError({ reason: "limit", path: at });
        const data = yield* io(fs.readFile(entry), at);
        bytes += data.byteLength;
        if (data.byteLength > MAX_FILE_BYTES || bytes > MAX_BYTES)
          return yield* new AgentFileSyncError({ reason: "limit", path: at });
        files.push({
          path: relative || "contents",
          data: Buffer.from(data).toString("base64"),
          mode: info.mode & 0o777,
        });
      } else return yield* new AgentFileSyncError({ reason: "linked-destination", path: at });
    });
    yield* visit(resolved, "", 0);
    if (kind === "skill" && !files.some((file) => file.path === "SKILL.md"))
      return yield* new AgentFileSyncError({ reason: "invalid-path", path: at });
    return files;
  });
  const textOf = (files: Snapshot) =>
    files?.[0] ? Buffer.from(files[0].data, "base64").toString("utf8") : "";
  const list: AgentFileSync["Service"]["list"] = Effect.fn("AgentFileSync.list")(function* (scope) {
    const base = yield* root(scope);
    const skills: AgentFileSyncCatalog["skills"][number][] = [];
    const instructions: AgentFileSyncCatalog["instructions"][number][] = [];
    const warnings: string[] = [];
    skillRoots: for (const directory of SKILL_ROOTS) {
      const names = yield* io(
        fs.readDirectory(path.join(base, directory)).pipe(
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed<readonly string[]>([])
                : Effect.fail(error),
          }),
        ),
        directory,
      );
      for (const name of [...names].sort()) {
        if (!validPart(name)) continue;
        const at = `${directory}/${name}`;
        if (yield* io(fs.exists(path.join(base, at, "SKILL.md")), at)) {
          if (skills.length >= 500) {
            warnings.push("Showing the first 500 skills.");
            break skillRoots;
          }
          skills.push({ path: at, name });
        }
      }
    }
    let instructionBytes = 0;
    for (const at of scope.cwd ? PROJECT_INSTRUCTIONS : PERSONAL_INSTRUCTIONS) {
      const result = yield* readSnapshot(base, at, "instructions").pipe(Effect.result);
      if (result._tag === "Failure") {
        warnings.push(result.failure.message);
        continue;
      }
      if (!result.success) continue;
      const contents = textOf(result.success);
      instructionBytes += Buffer.byteLength(contents);
      if (instructionBytes > MAX_BYTES) {
        warnings.push("Instruction inventory exceeds 4 MB.");
        break;
      }
      instructions.push({ path: at, sections: instructionSections(contents).slice(0, 100) });
    }
    return { skills, instructions, warnings };
  });
  const exportSelection: AgentFileSync["Service"]["export"] = Effect.fn("AgentFileSync.export")(
    function* (input) {
      const base = yield* root(input);
      const bundle: AgentFileSyncResource[] = [];
      for (const at of input.skills) {
        yield* validResource(input, at, "skill");
        const files = yield* readSnapshot(base, at, "skill");
        if (!files) return yield* new AgentFileSyncError({ reason: "changed", path: at });
        bundle.push({ kind: "skill", path: at, files });
      }
      for (const selection of input.instructions) {
        yield* validResource(input, selection.path, "instructions");
        const files = yield* readSnapshot(base, selection.path, "instructions");
        const sections = instructionSections(textOf(files)).filter((section) =>
          selection.sectionIds.includes(section.id),
        );
        if (!sections.length || sections.length !== new Set(selection.sectionIds).size)
          return yield* new AgentFileSyncError({ reason: "changed", path: selection.path });
        bundle.push({ kind: "instructions", path: selection.path, sections });
      }
      if (Buffer.byteLength(encodeBundle(bundle)) > MAX_BYTES)
        return yield* new AgentFileSyncError({ reason: "limit" });
      return bundle;
    },
  );
  const check: AgentFileSync["Service"]["check"] = Effect.fn("AgentFileSync.check")(
    function* (input) {
      const bundle = yield* exportSelection(input.selection);
      return { bundle: hash(encodeBundle(bundle)) === input.revision ? null : bundle };
    },
  );
  const prepare = Effect.fn("AgentFileSync.prepare")(function* (
    input: AgentFileSyncPreviewInput,
    previous?: AgentFileSyncBundle,
  ) {
    if (Buffer.byteLength(encodeBundle(input.bundle)) > MAX_BYTES)
      return yield* new AgentFileSyncError({ reason: "limit" });
    if (previous) {
      if (previous.length !== input.bundle.length)
        return yield* new AgentFileSyncError({ reason: "changed" });
      for (const resource of input.bundle) {
        const prior = previous.find((entry) => entry.path === resource.path);
        if (!prior || prior.kind !== resource.kind)
          return yield* new AgentFileSyncError({ reason: "changed", path: resource.path });
        if (
          prior.kind === "instructions" &&
          resource.kind === "instructions" &&
          (prior.sections.length !== resource.sections.length ||
            prior.sections.some(
              (section) => !resource.sections.some((other) => other.id === section.id),
            ))
        )
          return yield* new AgentFileSyncError({ reason: "changed", path: resource.path });
      }
    }
    const base = yield* root(input);
    const changes: {
      resource: AgentFileSyncResource;
      before: Snapshot;
      after: AgentFileSyncFile[];
      revision: string | null;
    }[] = [];
    const paths = new Set<string>();
    for (const resource of input.bundle) {
      yield* validResource(input, resource.path, resource.kind);
      if (paths.has(resource.path.toLowerCase()))
        return yield* new AgentFileSyncError({ reason: "invalid-path", path: resource.path });
      paths.add(resource.path.toLowerCase());
      const before = yield* readSnapshot(base, resource.path, resource.kind, true);
      let after: AgentFileSyncFile[];
      if (resource.kind === "skill") {
        const names = new Set<string>();
        const directories = new Map<string, string>();
        for (const file of resource.files) {
          if (
            !safeRelative(file.path) ||
            names.has(file.path.toLowerCase()) ||
            resource.files.some(
              (other) =>
                other.path !== file.path &&
                other.path.toLowerCase().startsWith(`${file.path.toLowerCase()}/`),
            )
          )
            return yield* new AgentFileSyncError({ reason: "invalid-path", path: file.path });
          const parts = file.path.split("/");
          if (parts.length > MAX_SKILL_DEPTH)
            return yield* new AgentFileSyncError({ reason: "limit", path: file.path });
          for (let index = 1; index < parts.length; index++) {
            const directory = parts.slice(0, index).join("/");
            const key = directory.toLowerCase();
            const existing = directories.get(key);
            if (existing !== undefined && existing !== directory)
              return yield* new AgentFileSyncError({ reason: "invalid-path", path: file.path });
            directories.set(key, directory);
          }
          names.add(file.path.toLowerCase());
          if (Buffer.from(file.data, "base64").toString("base64") !== file.data)
            return yield* new AgentFileSyncError({ reason: "invalid-path", path: file.path });
          if (Buffer.from(file.data, "base64").byteLength > MAX_FILE_BYTES)
            return yield* new AgentFileSyncError({ reason: "limit", path: file.path });
        }
        if (!resource.files.some((file) => file.path === "SKILL.md"))
          return yield* new AgentFileSyncError({ reason: "invalid-path", path: resource.path });
        after = destinationFiles(resource.files).sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
      } else {
        let text = textOf(before);
        const ids = new Set<string>();
        for (const section of resource.sections) {
          if (ids.has(section.id) || /<!-- \/?t3-sync:/.test(section.contents))
            return yield* new AgentFileSyncError({ reason: "invalid-block", path: resource.path });
          ids.add(section.id);
          const merged = mergeInstructionSection(
            text,
            hash(`${resource.path}\0${section.id}`),
            section.contents,
          );
          if (merged === null)
            return yield* new AgentFileSyncError({ reason: "invalid-block", path: resource.path });
          text = merged;
        }
        if (Buffer.byteLength(text) > MAX_FILE_BYTES)
          return yield* new AgentFileSyncError({ reason: "limit", path: resource.path });
        after = destinationFiles([
          {
            path: "contents",
            data: Buffer.from(text).toString("base64"),
            mode: before?.[0]?.mode ?? 0o600,
          },
        ]);
      }
      changes.push({ resource, before, after, revision: revision(before) });
    }
    return { base, changes };
  });
  const skillSummary = (files: Snapshot) => {
    const manifest = (files ?? [])
      .map(
        (file) =>
          `${file.path} · ${Buffer.from(file.data, "base64").byteLength} bytes · ${hash(file.data).slice(0, 12)}`,
      )
      .join("\n");
    const instructions = files?.find((file) => file.path === "SKILL.md");
    const contents = instructions ? Buffer.from(instructions.data, "base64").toString("utf8") : "";
    return `${contents.slice(0, 8000)}${contents.length > 8000 ? "\n… Skill instructions shortened" : ""}\n\nFiles\n${manifest.slice(0, 12000)}${manifest.length > 12000 ? "\n… File list shortened" : ""}`;
  };
  const preview: AgentFileSync["Service"]["preview"] = Effect.fn("AgentFileSync.preview")(
    function* (input, previous) {
      const { changes } = yield* prepare(input, previous);
      return changes.map(({ resource, before, after, revision: version }) => ({
        path: resource.path,
        revision: version,
        changed: version !== revision(after),
        before: resource.kind === "instructions" ? textOf(before) : skillSummary(before),
        after: resource.kind === "instructions" ? textOf(after) : skillSummary(after),
      }));
    },
  );
  const writeSnapshot = Effect.fn("AgentFileSync.writeSnapshot")(function* (
    base: string,
    at: string,
    kind: "skill" | "instructions",
    files: Snapshot,
    expected: string | null,
  ) {
    yield* assertUnlinked(base, at);
    const absolute = path.join(base, at);
    yield* io(fs.makeDirectory(path.dirname(absolute), { recursive: true, mode: 0o700 }), at);
    return yield* Effect.uninterruptible(
      Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* io(
            fs.makeTempDirectoryScoped({ directory: path.dirname(absolute), prefix: ".t3-sync-" }),
            at,
          );
          const staged = path.join(temporary, "new");
          if (files !== null) {
            if (kind === "skill") yield* io(fs.makeDirectory(staged, { mode: 0o700 }), at);
            for (const file of files) {
              const target = kind === "skill" ? path.join(staged, file.path) : staged;
              yield* io(
                fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 }),
                at,
              );
              yield* io(fs.writeFile(target, Buffer.from(file.data, "base64")), at);
              yield* io(fs.chmod(target, file.mode), at);
            }
            // Unsupported filesystems must fail before the original instructions leave their path.
            if (kind === "instructions")
              yield* io(fs.link(staged, path.join(temporary, "link-check")), at);
          }
          // Staging can take time. The earlier preview check cannot protect edits made during it.
          if (revision(yield* readSnapshot(base, at, kind, true)) !== expected)
            return yield* new AgentFileSyncError({ reason: "changed", path: at });
          const hasBackup = expected !== null;
          // Keep the backup outside the staging scope so a failed rollback cannot erase it.
          const backup = `${absolute}.t3-sync-backup-${NodeCrypto.randomUUID()}`;
          if (hasBackup) yield* io(fs.rename(absolute, backup), at);
          const installed = yield* Effect.gen(function* () {
            if (
              hasBackup &&
              revision(yield* readSnapshot(base, path.relative(base, backup), kind, true)) !==
                expected
            )
              return yield* new AgentFileSyncError({ reason: "changed", path: at });
            // A file recreated by an editor after capture must not be overwritten on installation.
            if (files !== null)
              yield* io(
                kind === "instructions" ? fs.link(staged, absolute) : fs.rename(staged, absolute),
                at,
              );
          }).pipe(Effect.result);
          if (installed._tag === "Failure") {
            if (hasBackup) {
              const restored = yield* Effect.gen(function* () {
                if (yield* io(fs.exists(absolute), at))
                  return yield* new AgentFileSyncError({ reason: "changed", path: at });
                if (kind === "instructions") {
                  yield* io(fs.link(backup, absolute), at);
                  yield* io(fs.remove(backup), at);
                } else yield* io(fs.rename(backup, absolute), at);
              }).pipe(Effect.result);
              if (restored._tag === "Failure")
                return yield* new AgentFileSyncError({
                  reason: "changed-backup",
                  path: backup,
                  cause: restored.failure,
                });
            }
            return yield* installed.failure;
          }
          if (hasBackup) {
            const checked = yield* readSnapshot(base, path.relative(base, backup), kind, true).pipe(
              Effect.result,
            );
            if (checked._tag === "Failure" || revision(checked.success) !== expected)
              return yield* new AgentFileSyncError({ reason: "changed-backup", path: backup });
            yield* fs.remove(backup, { recursive: true }).pipe(
              Effect.tapError(() =>
                Effect.logWarning("Could not remove a sync backup", { path: backup }),
              ),
              Effect.ignore,
            );
          }
        }),
      ),
    );
  });
  const applyUnlocked = Effect.fn("AgentFileSync.apply")(function* <E = never, R = never>(
    input: AgentFileSyncApplyInput,
    history = true,
    beforeWrite?: Effect.Effect<unknown, E, R>,
  ) {
    const { base, changes } = yield* prepare(input);
    for (const change of changes) {
      const expected = input.expected.find((entry) => entry.path === change.resource.path);
      if (!expected || expected.revision !== change.revision)
        return yield* new AgentFileSyncError({ reason: "changed", path: change.resource.path });
    }
    const changed = changes.filter((change) => change.revision !== revision(change.after));
    if (beforeWrite) yield* beforeWrite;
    if (!changed.length) return { undoId: null, paths: [], failures: [] };
    const undoId = history ? NodeCrypto.randomUUID() : null;
    const receipt = {
      scope: input.cwd ? { cwd: input.cwd } : {},
      entries: changed.map((change) => ({
        path: change.resource.path,
        kind: change.resource.kind,
        before: change.before,
        after: revision(change.after)!,
      })),
    };
    if (history) {
      yield* io(
        fs.makeDirectory(receiptDirectory, { recursive: true, mode: 0o700 }),
        "sync history",
      );
      const receiptPath = path.join(receiptDirectory, `${undoId}.json`);
      yield* io(
        writeFileStringAtomically({ filePath: receiptPath, contents: encodeReceipt(receipt) }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.andThen(fs.chmod(receiptPath, 0o600)),
        ),
        "sync history",
      );
    }
    const paths: string[] = [];
    const failures: AgentFileSyncApplyResult["failures"][number][] = [];
    for (const change of changed) {
      const result = yield* Effect.gen(function* () {
        const current = yield* readSnapshot(base, change.resource.path, change.resource.kind, true);
        if (revision(current) !== change.revision)
          return yield* new AgentFileSyncError({ reason: "changed", path: change.resource.path });
        yield* writeSnapshot(
          base,
          change.resource.path,
          change.resource.kind,
          change.after,
          change.revision,
        );
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        if (!history) return yield* result.failure;
        failures.push({ path: change.resource.path, message: result.failure.message });
      } else paths.push(change.resource.path);
    }
    return { undoId, paths, failures };
  });
  const apply: AgentFileSync["Service"]["apply"] = (input, history, beforeWrite) =>
    lock.withPermit(applyUnlocked(input, history, beforeWrite));
  const reconcile: AgentFileSync["Service"]["reconcile"] = Effect.fn("AgentFileSync.reconcile")(
    function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const { changes } = yield* prepare(input, input.previous);
          for (const change of changes) {
            const previous = input.previous.find((entry) => entry.path === change.resource.path)!;
            if (change.revision === revision(change.after)) continue;
            if (previous.kind === "skill") {
              if (change.revision !== revision(destinationFiles(previous.files)))
                return yield* new AgentFileSyncError({ reason: "changed", path: previous.path });
            } else {
              const current = textOf(change.before);
              for (const section of previous.sections) {
                if (
                  mergeInstructionSection(
                    current,
                    hash(`${previous.path}\0${section.id}`),
                    section.contents,
                  ) !== current
                )
                  return yield* new AgentFileSyncError({ reason: "changed", path: previous.path });
              }
            }
          }
          const result = yield* applyUnlocked(
            {
              ...input,
              expected: changes.map((change) => ({
                path: change.resource.path,
                revision: change.revision,
              })),
            },
            false,
          );
          if (result.failures.length)
            return yield* new AgentFileSyncError({ reason: "io", path: result.failures[0]!.path });
        }),
      );
    },
  );
  const undo: AgentFileSync["Service"]["undo"] = Effect.fn("AgentFileSync.undo")(function* ({
    undoId,
  }) {
    if (!/^[a-f0-9-]{36}$/.test(undoId))
      return yield* new AgentFileSyncError({ reason: "invalid-path" });
    return yield* lock.withPermit(
      Effect.gen(function* () {
        const receiptPath = path.join(receiptDirectory, `${undoId}.json`);
        const receipt = yield* io(
          fs.readFileString(receiptPath).pipe(Effect.flatMap(decodeReceipt)),
          "sync history",
        );
        const base = yield* root(receipt.scope);
        const paths: string[] = [];
        const failures: AgentFileSyncApplyResult["failures"][number][] = [];
        for (const entry of receipt.entries) {
          const result = yield* Effect.gen(function* () {
            yield* validResource(receipt.scope, entry.path, entry.kind);
            const current = yield* readSnapshot(base, entry.path, entry.kind, true);
            if (revision(current) === revision(entry.before)) return;
            if (revision(current) !== entry.after)
              return yield* new AgentFileSyncError({ reason: "changed", path: entry.path });
            yield* writeSnapshot(base, entry.path, entry.kind, entry.before, entry.after);
            paths.push(entry.path);
          }).pipe(Effect.result);
          if (result._tag === "Failure")
            failures.push({ path: entry.path, message: result.failure.message });
        }
        if (!failures.length) yield* io(fs.remove(receiptPath), "sync history");
        return { undoId: failures.length ? undoId : null, paths, failures };
      }),
    );
  });
  const discard: AgentFileSync["Service"]["discard"] = Effect.fn("AgentFileSync.discard")(
    function* ({ undoId }) {
      if (!/^[a-f0-9-]{36}$/.test(undoId))
        return yield* new AgentFileSyncError({ reason: "invalid-path" });
      yield* lock.withPermit(
        io(
          fs.remove(path.join(receiptDirectory, `${undoId}.json`), { force: true }),
          "sync history",
        ),
      );
    },
  );
  return AgentFileSync.of({
    list,
    check,
    export: exportSelection,
    preview,
    apply,
    reconcile,
    undo,
    discard,
  });
});

export const layer = Layer.effect(AgentFileSync, make);
