// @effect-diagnostics nodeBuiltinImport:off -- lstat and no-follow file handles protect sync from symlink traversal
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import { parse as parseYaml } from "yaml";
import {
  McpServersFile,
  ProfileId,
  ProfilesFile,
  ProviderSettingsFile,
  ProfilesEditorWriteInput,
  ProfilesSkillsInput,
  ProfilesSyncState,
  ProfilesError,
  type ProfileSkill,
  type ProfilesEditorState,
  type ProfilesSkillsResult,
  type ProfilesSyncReadInput,
  type ProfilesSyncReadResult,
  type ProfilesSyncWriteInput,
  type ProfilesSyncWriteResult,
  type ProfilesSyncMarkInput,
  type ProfilesBundleFile,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Profiles from "./Profiles.ts";
import * as ProfilesCommandRunner from "./ProfilesCommandRunner.ts";

const decodeSyncState = Schema.decodeUnknownSync(ProfilesSyncState);
const decodeProfilesFile = Schema.decodeUnknownSync(ProfilesFile);
const decodeProviderSettings = Schema.decodeUnknownSync(ProviderSettingsFile);
const decodeMcpServers = Schema.decodeUnknownSync(McpServersFile);
const isProfileId = Schema.is(ProfileId);
const decodeWrite = Schema.decodeEffect(ProfilesEditorWriteInput);
const decodeSkills = Schema.decodeEffect(ProfilesSkillsInput);
const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 8 * FILE_LIMIT;
const excluded = new Set([".git", "node_modules", ".t3-sync.json", ".DS_Store"]);
const invalid = () =>
  new ProfilesError({
    reason: "invalid",
    message: "Invalid profiles file, path, schema, or bundle size/hash.",
  });
const conflict = () =>
  new ProfilesError({
    reason: "conflict",
    message: "The profiles folder changed. Read it again before saving or syncing.",
  });
const isProfilesError = Schema.is(ProfilesError);
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
const digest = (content: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(content).digest("hex");
// Windows reports no executable bits, so they are applied on write but left out of the hash;
// otherwise a bundle with scripts could never match after copying to Windows.
const bundleHash = (files: readonly ProfilesBundleFile[]) =>
  digest(
    JSON.stringify(
      [...files]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((file) => [file.path, digest(Buffer.from(file.contentBase64, "base64"))]),
    ),
  );
const safeRelative = (file: string) =>
  file.length > 0 &&
  !file.includes("\\") &&
  !file.includes("\0") &&
  !/^[a-zA-Z]:/.test(file) &&
  !NodePath.posix.isAbsolute(file) &&
  NodePath.posix.normalize(file) === file &&
  file
    .split("/")
    .every((part) => part !== ".." && part !== "." && part !== "" && !excluded.has(part));

async function stat(file: string) {
  try {
    return await NodeFSP.lstat(file);
  } catch (cause) {
    if (isMissing(cause)) return undefined;
    throw cause;
  }
}
async function safeTarget(root: string, relative: string) {
  if (!safeRelative(relative)) throw invalid();
  let target = root;
  for (const part of relative.split("/")) {
    target = NodePath.join(target, part);
    if ((await stat(target))?.isSymbolicLink()) throw invalid();
  }
  return target;
}
async function readRegular(file: string) {
  const handle = await NodeFSP.open(file, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > FILE_LIMIT) throw invalid();
    const buffer = await handle.readFile();
    if (buffer.byteLength > FILE_LIMIT) throw invalid();
    return buffer;
  } finally {
    await handle.close();
  }
}
async function atomicWrite(file: string, content: Uint8Array | string, executable = false) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, content, { flag: "wx", mode: executable ? 0o755 : 0o644 });
    await NodeFSP.rename(temporary, file);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}
async function scan(root: string) {
  const files: ProfilesBundleFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let newestMs = 0;
  async function visit(relative: string) {
    const absolute = NodePath.join(root, relative);
    const info = await stat(absolute);
    if (!info) return;
    if (info.isSymbolicLink()) {
      skipped.push(relative);
      return;
    }
    if (info.isDirectory()) {
      for (const name of (await NodeFSP.readdir(absolute)).sort()) {
        const next = relative ? `${relative}/${name}` : name;
        if (excluded.has(name)) skipped.push(next);
        else await visit(next);
      }
    } else if (info.isFile() && info.size <= FILE_LIMIT) {
      const content = await readRegular(absolute);
      total += content.length;
      if (total > TOTAL_LIMIT) throw invalid();
      newestMs = Math.max(newestMs, info.mtimeMs);
      files.push({
        path: relative,
        contentBase64: content.toString("base64"),
        executable: (info.mode & 0o111) !== 0,
      });
    } else skipped.push(relative);
  }
  await visit("");
  return { files, skipped, hash: bundleHash(files), newestMs };
}
function validateBundle(files: readonly ProfilesBundleFile[]) {
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!safeRelative(file.path) || paths.has(file.path)) throw invalid();
    paths.add(file.path);
    if (file.contentBase64.length > Math.ceil(FILE_LIMIT / 3) * 4) throw invalid();
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.length > FILE_LIMIT || content.toString("base64") !== file.contentBase64)
      throw invalid();
    total += content.length;
    if (total > TOTAL_LIMIT) throw invalid();
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/"))) throw invalid();
    }
  }
}

export class ProfilesStore extends Context.Service<
  ProfilesStore,
  {
    readonly read: () => Effect.Effect<ProfilesEditorState, ProfilesError>;
    readonly write: (
      input: ProfilesEditorWriteInput,
    ) => Effect.Effect<ProfilesEditorState, ProfilesError>;
    readonly skills: (
      input: ProfilesSkillsInput,
    ) => Effect.Effect<ProfilesSkillsResult, ProfilesError>;
    readonly syncRead: (
      input: typeof ProfilesSyncReadInput.Type,
    ) => Effect.Effect<ProfilesSyncReadResult, ProfilesError>;
    readonly syncWrite: (
      input: typeof ProfilesSyncWriteInput.Type,
    ) => Effect.Effect<ProfilesSyncWriteResult, ProfilesError>;
    readonly syncMark: (
      input: typeof ProfilesSyncMarkInput.Type,
    ) => Effect.Effect<ProfilesSyncState, ProfilesError>;
  }
>()("t3/profiles/ProfilesStore") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const loader = yield* Profiles.Profiles;
  const runner = yield* ProfilesCommandRunner.ProfilesCommandRunner;
  const lock = yield* Semaphore.make(1);
  const io = Effect.fn("ProfilesStore.io")(<A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        isProfilesError(cause)
          ? cause
          : new ProfilesError({
              reason: "io",
              message: "Could not read or write the profiles folder. Check file permissions.",
            }),
    }).pipe(Effect.uninterruptible),
  );
  const readSettings = settings.getSettings.pipe(
    Effect.mapError(
      () =>
        new ProfilesError({ reason: "io", message: "Could not read profiles folder settings." }),
    ),
  );
  const syncOff = () =>
    new ProfilesError({
      reason: "unavailable",
      message: "Profile sync is off on this environment.",
    });
  const folder = Effect.fn("ProfilesStore.folder")(function* () {
    const value = yield* readSettings;
    const root = NodePath.resolve(Profiles.resolveFolder(config.baseDir, value.profilesFolder));
    return yield* io(async () => {
      const info = await stat(root);
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw invalid();
      return root;
    });
  });
  const persist = async (root: string, state: ProfilesSyncState) => {
    const target = NodePath.join(root, ".t3-sync.json");
    if ((await stat(target))?.isSymbolicLink()) throw invalid();
    await atomicWrite(target, JSON.stringify(state));
  };
  const snapshot = Effect.fn("ProfilesStore.snapshot")(function* (root: string) {
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* io(async () => {
      const current = await scan(root);
      let state: ProfilesSyncState = {
        revision: 0,
        hash: bundleHash([]),
        syncedHash: null,
        updatedAt: null,
      };
      const statePath = NodePath.join(root, ".t3-sync.json");
      if (await stat(statePath)) {
        try {
          state = decodeSyncState(JSON.parse((await readRegular(statePath)).toString("utf8")));
        } catch {
          throw invalid();
        }
      }
      if (current.hash !== state.hash) {
        // An edit outside T3 is dated by its files, so a copy edited while offline is not newer
        // than it is. A deletion leaves no file time behind and is dated now.
        const edited = DateTime.formatIso(DateTime.makeUnsafe(current.newestMs));
        const updatedAt =
          state.updatedAt === null || Date.parse(edited) > Date.parse(state.updatedAt)
            ? edited
            : now;
        state = { ...state, hash: current.hash, revision: state.revision + 1, updatedAt };
        await persist(root, state);
      }
      return { ...current, state };
    });
  });
  const bump = Effect.fn("ProfilesStore.bump")(function* (
    root: string,
    previous: ProfilesSyncState,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* io(async () => {
      const current = await scan(root);
      await persist(root, {
        ...previous,
        hash: current.hash,
        revision: previous.revision + 1,
        updatedAt: now,
      });
    });
  });
  const editor = Effect.fn("ProfilesStore.editor")(function* (root: string) {
    const current = yield* snapshot(root);
    const catalog = (yield* loader.load(root)).catalog;
    return yield* io(async (): Promise<ProfilesEditorState> => {
      const contents = new Map(
        current.files.map((file) => [
          file.path,
          Buffer.from(file.contentBase64, "base64").toString("utf8"),
        ]),
      );
      let profiles: ProfilesFile | null = null;
      let providerSettings: ProviderSettingsFile = {};
      // Left out when it cannot be decoded, so the editor cannot save over the broken file.
      let mcpServers: McpServersFile | undefined = { mcpServers: {} };
      let error: string | undefined;
      const exists = (await stat(NodePath.join(root, "profiles.json"))) !== undefined;
      try {
        if (exists) profiles = decodeProfilesFile(JSON.parse(contents.get("profiles.json") ?? ""));
      } catch {
        error = "Could not decode profiles.json. Check the profiles format.";
      }
      try {
        if (await stat(NodePath.join(root, "provider-settings.json")))
          providerSettings = decodeProviderSettings(
            JSON.parse(contents.get("provider-settings.json") ?? ""),
          );
      } catch {
        error = "Could not decode provider-settings.json. Check the provider settings format.";
      }
      try {
        if (contents.has("mcp-servers.json"))
          mcpServers = decodeMcpServers(JSON.parse(contents.get("mcp-servers.json") ?? ""));
      } catch {
        mcpServers = undefined;
        error = "Could not decode mcp-servers.json. Check the MCP servers format.";
      }
      let sources: Record<string, { source?: string }> = {};
      try {
        const lockFile = JSON.parse(contents.get("skills-lock.json") ?? "{}");
        sources = lockFile.skills ?? {};
      } catch {
        /* A broken CLI lock file must not hide installed skills. */
      }
      const prompts = [...contents].flatMap(([file, content]) => {
        const match = /^prompts\/([^/]+)\.md$/.exec(file);
        return match && isProfileId(match[1]) ? [{ name: match[1], content }] : [];
      });
      const skills: ProfileSkill[] = [];
      for (const [file, content] of contents) {
        const match = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/.exec(file);
        if (!match || !isProfileId(match[1])) continue;
        const name = match[1];
        let description: string | undefined;
        let warning: string | undefined;
        try {
          const metadata = parseYaml(
            /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "",
          );
          if (typeof metadata?.description !== "string")
            warning = "Skill description is missing or invalid.";
          else description = metadata.description;
        } catch {
          warning = "Skill frontmatter is invalid.";
        }
        const skillRoot = NodePath.dirname(NodePath.join(root, file));
        const source = sources[name]?.source;
        skills.push({
          name,
          path: NodePath.join(root, file),
          ...(description === undefined ? {} : { description }),
          ...(typeof source === "string" ? { source } : {}),
          needsInstall:
            !!(await stat(NodePath.join(skillRoot, "package.json"))) &&
            !(await stat(NodePath.join(skillRoot, "node_modules"))),
          ...(warning === undefined ? {} : { warning }),
        });
      }
      return {
        folder: root,
        exists,
        profiles,
        providerSettings,
        ...(mcpServers === undefined ? {} : { mcpServers }),
        prompts,
        skills,
        catalog,
        sync: current.state,
        ...(error === undefined ? {} : { error }),
      };
    });
  });
  const read = Effect.fn("ProfilesStore.read")(function* () {
    return yield* editor(yield* folder());
  }, lock.withPermit);
  const write = Effect.fn("ProfilesStore.write")(function* (input: ProfilesEditorWriteInput) {
    const decoded = yield* decodeWrite(input).pipe(Effect.mapError(() => invalid()));
    const root = yield* folder();
    const before = yield* snapshot(root);
    if (
      input.expectedRevision !== before.state.revision ||
      (input.expectedHash !== undefined && input.expectedHash !== before.state.hash)
    )
      return yield* conflict();
    yield* io(async () => {
      const writes: Array<[string, string]> = [];
      if (decoded.profiles !== undefined)
        writes.push(["profiles.json", JSON.stringify(decoded.profiles, null, 2)]);
      if (decoded.providerSettings !== undefined)
        writes.push(["provider-settings.json", JSON.stringify(decoded.providerSettings, null, 2)]);
      if (decoded.mcpServers !== undefined)
        writes.push(["mcp-servers.json", JSON.stringify(decoded.mcpServers, null, 2)]);
      for (const prompt of decoded.prompts?.upsert ?? [])
        writes.push([`prompts/${prompt.name}.md`, prompt.content]);
      const removals = (decoded.prompts?.remove ?? []).map((name) => `prompts/${name}.md`);
      for (const [path] of writes) await safeTarget(root, path);
      for (const path of removals) await safeTarget(root, path);
      const next = new Map(before.files.map((file) => [file.path, file]));
      for (const path of removals) next.delete(path);
      for (const [path, content] of writes)
        next.set(path, { path, contentBase64: Buffer.from(content).toString("base64") });
      validateBundle([...next.values()]);
      for (const path of removals) await NodeFSP.rm(NodePath.join(root, path), { force: true });
      for (const [path, content] of writes) await atomicWrite(NodePath.join(root, path), content);
    });
    yield* bump(root, before.state);
    return yield* editor(root);
  }, lock.withPermit);
  const syncRead = Effect.fn("ProfilesStore.syncRead")(function* (
    input: typeof ProfilesSyncReadInput.Type,
  ) {
    const enabled = (yield* readSettings).profilesSync;
    if (!enabled && input.includeFiles) return yield* syncOff();
    const current = yield* snapshot(yield* folder());
    return {
      state: current.state,
      enabled,
      skipped: current.skipped,
      ...(input.includeFiles ? { files: current.files } : {}),
    };
  }, lock.withPermit);
  const syncWrite = Effect.fn("ProfilesStore.syncWrite")(function* (
    input: typeof ProfilesSyncWriteInput.Type,
  ) {
    if (!(yield* readSettings).profilesSync) return yield* syncOff();
    const root = yield* folder();
    const before = yield* snapshot(root);
    if (
      input.expectedRevision !== before.state.revision ||
      (input.expectedHash !== undefined && input.expectedHash !== before.state.hash)
    )
      return yield* conflict();
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* io(async () => {
      validateBundle(input.files);
      if (
        bundleHash(input.files) !== input.source.hash ||
        (input.source.updatedAt !== null && Number.isNaN(Date.parse(input.source.updatedAt)))
      )
        throw invalid();
      for (const file of input.files) {
        const target = await safeTarget(root, file.path);
        const info = await stat(target);
        // Never replace excluded or non-regular objects, including a directory containing node_modules.
        if (info && (!info.isFile() || info.size > FILE_LIMIT)) throw invalid();
      }
      let backupPath: string | undefined;
      if (before.hash !== before.state.syncedHash && before.hash !== input.source.hash) {
        const parent = NodePath.join(config.baseDir, "profiles-backups");
        await NodeFSP.mkdir(parent, { recursive: true });
        backupPath = await NodeFSP.mkdtemp(NodePath.join(parent, `${now.replaceAll(":", "-")}-`));
        for (const file of before.files)
          await atomicWrite(
            NodePath.join(backupPath, file.path),
            Buffer.from(file.contentBase64, "base64"),
            file.executable,
          );
      }
      for (const file of input.files)
        await atomicWrite(
          await safeTarget(root, file.path),
          Buffer.from(file.contentBase64, "base64"),
          file.executable,
        );
      const wanted = new Set(input.files.map((file) => file.path));
      for (const file of before.files)
        if (!wanted.has(file.path)) await NodeFSP.unlink(await safeTarget(root, file.path));
      const after = await scan(root);
      if (after.hash !== input.source.hash) throw invalid();
      const state = {
        revision: before.state.revision + 1,
        hash: after.hash,
        syncedHash: after.hash,
        updatedAt: input.source.updatedAt ?? now,
      };
      await persist(root, state);
      return { state, ...(backupPath === undefined ? {} : { backupPath }) };
    });
  }, lock.withPermit);
  const syncMark = Effect.fn("ProfilesStore.syncMark")(function* (
    input: typeof ProfilesSyncMarkInput.Type,
  ) {
    const root = yield* folder();
    const current = yield* snapshot(root);
    if (current.hash !== input.hash) return yield* conflict();
    const state = { ...current.state, syncedHash: input.hash };
    yield* io(() => persist(root, state));
    return state;
  }, lock.withPermit);
  const skills = Effect.fn("ProfilesStore.skills")(function* (input: ProfilesSkillsInput) {
    const decoded = yield* decodeSkills(input).pipe(Effect.mapError(() => invalid()));
    const root = yield* folder();
    const before = yield* snapshot(root);
    yield* io(async () => {
      await safeTarget(root, ".agents/skills");
      await NodeFSP.mkdir(root, { recursive: true });
    });
    let cwd = root;
    let command = "npx";
    let args: string[];
    switch (decoded._tag) {
      case "add":
        args = [
          "-y",
          "skills@1",
          "add",
          decoded.source,
          ...(decoded.skill === undefined ? [] : ["-s", decoded.skill]),
          "-a",
          "codex",
          "-y",
          "--copy",
        ];
        break;
      case "update":
        args = ["-y", "skills@1", "update", "-p", "-y"];
        break;
      case "remove":
        args = ["-y", "skills@1", "remove", decoded.name, "-a", "codex", "-y"];
        break;
      case "install":
        cwd = yield* io(async () => {
          const target = await safeTarget(root, `.agents/skills/${decoded.name}/package.json`);
          if (!(await stat(target))?.isFile()) throw invalid();
          return NodePath.dirname(target);
        });
        command = "npm";
        args = ["install", "--omit=dev", "--no-audit", "--no-fund"];
        break;
    }
    const result = yield* runner.run({ command, args, cwd }).pipe(Effect.result);
    // Failed commands can still have changed files, so persist their revision too.
    yield* bump(root, before.state);
    if (result._tag === "Failure") return yield* result.failure;
    return { output: result.success, state: yield* editor(root) };
  }, lock.withPermit);
  return ProfilesStore.of({ read, write, skills, syncRead, syncWrite, syncMark });
});
export const layer = Layer.effect(ProfilesStore, make);
