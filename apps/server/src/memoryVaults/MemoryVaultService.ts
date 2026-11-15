import {
  MemoryVaultError,
  MemoryVaultFilePath,
  MemoryVaultSettings,
  type MemoryVaultAccess,
  type MemoryVaultFile,
  type MemoryVaultManageInput,
  type MemoryVaultOverview,
  type MemoryVaultSearchHit,
  type MemoryVaultSelection,
  type MemoryVaultSettingsPatch,
  type MemoryVaultSummary,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { redactSecrets } from "@t3tools/shared/secretRedaction";

import * as ServerConfig from "../config.ts";
import {
  DEFAULT_VAULT_FILES,
  asksForWholeVault,
  rankSections,
  renderVaultContext,
  selectVaultSections,
  slugifyVaultName,
  splitSections,
  type VaultSection,
} from "./memoryVaultText.ts";

const ThreadSelection = Schema.Struct({
  vaultId: Schema.NullOr(Schema.String),
  access: Schema.Literals(["read-write", "read-only", "reference"]),
});
const StoredState = Schema.Struct({
  settings: MemoryVaultSettings,
  threads: Schema.Record(Schema.String, ThreadSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
type StoredState = typeof StoredState.Type;
const decodeState = Schema.decodeEffect(fromLenientJson(StoredState));
const decodeStateSync = Schema.decodeSync(StoredState);
const encodeState = Schema.encodeEffect(Schema.fromJsonString(StoredState));
const VaultMeta = Schema.Struct({ name: Schema.String, createdAt: Schema.String });
const decodeMeta = Schema.decodeEffect(fromLenientJson(VaultMeta));
const encodeMeta = Schema.encodeEffect(Schema.fromJsonString(VaultMeta));
const isVaultFilePath = Schema.is(MemoryVaultFilePath);

const META_FILE = ".vault.json";
const MAX_FILE_CHARS = 256_000;

const vaultError = (message: string) => new MemoryVaultError({ message });
const fail = (message: string) => () => vaultError(message);

export type MemoryUpdateMode = "append" | "replace_section" | "replace_file";

interface ThreadVault {
  readonly vaultId: string;
  readonly name: string;
  readonly access: MemoryVaultAccess;
}

export class MemoryVaultService extends Context.Service<
  MemoryVaultService,
  {
    readonly overview: (threadId?: string) => Effect.Effect<MemoryVaultOverview, MemoryVaultError>;
    readonly updateSettings: (
      patch: MemoryVaultSettingsPatch,
    ) => Effect.Effect<MemoryVaultOverview, MemoryVaultError>;
    readonly manage: (
      input: MemoryVaultManageInput,
    ) => Effect.Effect<{ vaultId: string | null; path: string | null }, MemoryVaultError>;
    readonly readFile: (vaultId: string, path: string) => Effect.Effect<string, MemoryVaultError>;
    readonly writeFile: (
      vaultId: string,
      path: string,
      content: string,
    ) => Effect.Effect<void, MemoryVaultError>;
    readonly search: (
      query: string,
      vaultId?: string,
    ) => Effect.Effect<ReadonlyArray<MemoryVaultSearchHit>, MemoryVaultError>;
    readonly select: (input: {
      readonly threadId: string;
      readonly vaultId?: string | null;
      readonly access?: MemoryVaultAccess;
      readonly reset?: boolean;
    }) => Effect.Effect<MemoryVaultOverview, MemoryVaultError>;
    /** Context for one turn, or "" when the thread uses no vault. Never fails the turn. */
    readonly contextForTurn: (input: {
      readonly threadId: string;
      readonly userText: string;
      readonly projectName: string | null;
    }) => Effect.Effect<string>;
    readonly vaultForThread: (threadId: string) => Effect.Effect<ThreadVault, MemoryVaultError>;
    readonly agentUpdate: (input: {
      readonly threadId: string;
      readonly path: string;
      readonly content: string;
      readonly mode: MemoryUpdateMode;
      readonly section?: string;
    }) => Effect.Effect<
      {
        readonly vault: string;
        readonly path: string;
        readonly chars: number;
        readonly redacted: number;
      },
      MemoryVaultError
    >;
  }
>()("t3/memoryVaults/MemoryVaultService") {}

/** Replaces the body under `heading`, or appends the heading when the file lacks it. */
function replaceMarkdownSection(existing: string, heading: string, content: string): string {
  const lines = existing.split("\n");
  const start = lines.findIndex(
    (line) => /^#{1,6}\s/.test(line) && line.replace(/^#+\s+/, "").trim() === heading,
  );
  if (start === -1) return `${existing.trimEnd()}\n\n## ${heading}\n\n${content}\n`;
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const match = /^(#+)\s/.exec(lines[index]!);
    if (match && match[1]!.length <= level) {
      end = index;
      break;
    }
  }
  const after = lines.slice(end);
  return [
    ...lines.slice(0, start + 1),
    "",
    content,
    ...(after.length > 0 ? ["", ...after] : [""]),
  ].join("\n");
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(config.stateDir, "memory-vaults.json");
  const defaultRoot = path.join(config.baseDir, "memory-vaults");
  const lock = yield* Semaphore.make(1);
  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  const readState = fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => decodeStateSync({ settings: {} })),
  );
  const writeState = (state: StoredState) =>
    encodeState(state).pipe(
      Effect.flatMap((contents) => atomicWrite(statePath, contents)),
      Effect.mapError(fail("Could not save memory vault settings.")),
    );

  const rootOf = (state: StoredState) =>
    state.settings.storageRoot.trim() === "" ? defaultRoot : state.settings.storageRoot.trim();
  const vaultDir = (state: StoredState, vaultId: string) => path.join(rootOf(state), vaultId);

  const listFiles = Effect.fn("MemoryVaultService.listFiles")(function* (dir: string) {
    const files: Array<MemoryVaultFile> = [];
    // Notes live at the top level or one folder down.
    const folders: Array<readonly [string, string]> = [[dir, ""]];
    for (let index = 0; index < folders.length; index++) {
      const [folder, prefix] = folders[index]!;
      const names = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.toSorted()) {
        if (name.startsWith(".")) continue;
        const full = path.join(folder, name);
        const info = yield* fs.stat(full).pipe(Effect.option);
        if (Option.isNone(info)) continue;
        const relative = prefix === "" ? name : `${prefix}/${name}`;
        if (info.value.type === "Directory" && prefix === "") {
          folders.push([full, relative]);
        } else if (info.value.type === "File" && isVaultFilePath(relative)) {
          files.push({
            path: relative,
            bytes: Number(info.value.size),
            updatedAt: Option.match(info.value.mtime, {
              onNone: () => "",
              onSome: (date) => date.toISOString(),
            }),
          });
        }
      }
    }
    return files;
  });

  const listVaults = Effect.fn("MemoryVaultService.listVaults")(function* (state: StoredState) {
    const root = rootOf(state);
    const names = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const vaults: Array<MemoryVaultSummary> = [];
    for (const id of names) {
      const meta = yield* fs
        .readFileString(path.join(root, id, META_FILE))
        .pipe(Effect.flatMap(decodeMeta), Effect.option);
      if (Option.isNone(meta)) continue;
      vaults.push({
        id,
        name: meta.value.name,
        createdAt: meta.value.createdAt,
        files: yield* listFiles(path.join(root, id)),
      });
    }
    return vaults.toSorted((left, right) => left.name.localeCompare(right.name));
  });

  const selectionFor = (state: StoredState, threadId: string): MemoryVaultSelection => {
    const own = state.threads[threadId];
    if (own !== undefined) return { vaultId: own.vaultId, access: own.access, inherited: false };
    return {
      vaultId: state.settings.defaultVaultId,
      access: state.settings.defaultAccess,
      inherited: true,
    };
  };

  const overviewOf = Effect.fn("MemoryVaultService.overviewOf")(function* (
    state: StoredState,
    threadId?: string,
  ) {
    return {
      settings: state.settings,
      storageRoot: rootOf(state),
      vaults: yield* listVaults(state),
      ...(threadId === undefined ? {} : { selection: selectionFor(state, threadId) }),
    } satisfies MemoryVaultOverview;
  });

  const writeMeta = (dir: string, meta: typeof VaultMeta.Type) =>
    encodeMeta(meta).pipe(
      Effect.flatMap((contents) => atomicWrite(path.join(dir, META_FILE), contents)),
      Effect.mapError(fail("Could not write the vault.")),
    );

  const createVault = Effect.fn("MemoryVaultService.createVault")(function* (
    state: StoredState,
    name: string,
    withTemplates: boolean,
  ) {
    const trimmed = name.trim().slice(0, 80);
    if (trimmed === "") return yield* vaultError("Give the vault a name.");
    const root = rootOf(state);
    const base = slugifyVaultName(trimmed);
    let id = base;
    for (
      let suffix = 2;
      yield* fs.exists(path.join(root, id)).pipe(Effect.orElseSucceed(() => false));
      suffix++
    ) {
      id = `${base}-${suffix}`;
    }
    const dir = path.join(root, id);
    yield* fs
      .makeDirectory(dir, { recursive: true })
      .pipe(Effect.mapError(fail(`Could not create ${dir}.`)));
    yield* writeMeta(dir, { name: trimmed, createdAt: DateTime.formatIso(yield* DateTime.now) });
    if (withTemplates) {
      for (const [file, content] of DEFAULT_VAULT_FILES) {
        yield* atomicWrite(path.join(dir, file), content).pipe(
          Effect.mapError(fail("Could not write the vault.")),
        );
      }
    }
    return id;
  });

  const requireVault = Effect.fn("MemoryVaultService.requireVault")(function* (
    state: StoredState,
    vaultId: string,
  ) {
    const dir = vaultDir(state, vaultId);
    const meta = yield* fs
      .readFileString(path.join(dir, META_FILE))
      .pipe(
        Effect.flatMap(decodeMeta),
        Effect.mapError(fail("That memory vault no longer exists.")),
      );
    return { dir, meta };
  });

  const readVaultSections = Effect.fn("MemoryVaultService.readVaultSections")(function* (
    dir: string,
  ) {
    const sections: Array<VaultSection> = [];
    const files = yield* listFiles(dir);
    for (const file of files) {
      const content = yield* fs
        .readFileString(path.join(dir, file.path))
        .pipe(Effect.orElseSucceed(() => ""));
      sections.push(...splitSections(file.path, content));
    }
    return { files, sections };
  });

  const copyTextFiles = Effect.fn("MemoryVaultService.copyTextFiles")(function* (
    from: string,
    to: string,
  ) {
    const files = yield* listFiles(from);
    for (const file of files) {
      const content = yield* fs
        .readFileString(path.join(from, file.path))
        .pipe(Effect.mapError(fail(`Could not read ${file.path}.`)));
      const target = path.join(to, file.path);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.ignore);
      yield* atomicWrite(target, content).pipe(Effect.mapError(fail(`Could not write ${target}.`)));
    }
    return files.length;
  });

  const writeVaultFile = Effect.fn("MemoryVaultService.writeVaultFile")(function* (
    dir: string,
    file: string,
    content: string,
  ) {
    if (!isVaultFilePath(file)) return yield* vaultError("Vault notes are .md or .txt files.");
    if (content.length > MAX_FILE_CHARS) {
      return yield* vaultError("That note is too large; split it into several files.");
    }
    const target = path.join(dir, file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(Effect.ignore);
    yield* atomicWrite(target, content).pipe(Effect.mapError(fail(`Could not save ${file}.`)));
  });

  const overview = Effect.fn("MemoryVaultService.overview")(function* (threadId?: string) {
    return yield* overviewOf(yield* readState, threadId);
  });

  const updateSettings = Effect.fn("MemoryVaultService.updateSettings")(function* (
    patch: MemoryVaultSettingsPatch,
  ) {
    const state = yield* readState;
    const next = { ...state, settings: { ...state.settings, ...patch } };
    yield* writeState(next);
    return yield* overviewOf(next);
  }, lock.withPermits(1));

  const manage = Effect.fn("MemoryVaultService.manage")(function* (input: MemoryVaultManageInput) {
    const state = yield* readState;
    switch (input.action) {
      case "create": {
        const id = yield* createVault(state, input.name, true);
        return { vaultId: id, path: vaultDir(state, id) };
      }
      case "rename": {
        const vault = yield* requireVault(state, input.vaultId);
        const name = input.name.trim().slice(0, 80);
        if (name === "") return yield* vaultError("Give the vault a name.");
        yield* writeMeta(vault.dir, { ...vault.meta, name });
        return { vaultId: input.vaultId, path: vault.dir };
      }
      case "delete": {
        const vault = yield* requireVault(state, input.vaultId);
        yield* fs
          .remove(vault.dir, { recursive: true })
          .pipe(Effect.mapError(fail("Could not delete the vault.")));
        yield* writeState({
          settings: {
            ...state.settings,
            defaultVaultId:
              state.settings.defaultVaultId === input.vaultId
                ? null
                : state.settings.defaultVaultId,
          },
          threads: Object.fromEntries(
            Object.entries(state.threads).filter(
              ([, selection]) => selection.vaultId !== input.vaultId,
            ),
          ),
        });
        return { vaultId: null, path: null };
      }
      case "export": {
        const vault = yield* requireVault(state, input.vaultId);
        const target = path.resolve(input.directory);
        yield* fs
          .makeDirectory(target, { recursive: true })
          .pipe(Effect.mapError(fail(`Could not create ${target}.`)));
        yield* copyTextFiles(vault.dir, target);
        return { vaultId: input.vaultId, path: target };
      }
      case "import": {
        const source = path.resolve(input.directory);
        const id = yield* createVault(state, input.name, false);
        const copied = yield* copyTextFiles(source, vaultDir(state, id));
        if (copied === 0) {
          yield* fs.remove(vaultDir(state, id), { recursive: true }).pipe(Effect.ignore);
          return yield* vaultError(`No Markdown or text files were found in ${source}.`);
        }
        return { vaultId: id, path: vaultDir(state, id) };
      }
    }
  }, lock.withPermits(1));

  const readFile = Effect.fn("MemoryVaultService.readFile")(function* (
    vaultId: string,
    file: string,
  ) {
    if (!isVaultFilePath(file)) return yield* vaultError("That is not a vault note.");
    const vault = yield* requireVault(yield* readState, vaultId);
    return yield* fs
      .readFileString(path.join(vault.dir, file))
      .pipe(Effect.mapError(fail(`${file} does not exist in this vault.`)));
  });

  const writeFile = Effect.fn("MemoryVaultService.writeFile")(function* (
    vaultId: string,
    file: string,
    content: string,
  ) {
    const vault = yield* requireVault(yield* readState, vaultId);
    yield* writeVaultFile(vault.dir, file, content);
  }, lock.withPermits(1));

  const search = Effect.fn("MemoryVaultService.search")(function* (
    query: string,
    vaultId?: string,
  ) {
    const state = yield* readState;
    const vaults = (yield* listVaults(state)).filter(
      (vault) => vaultId === undefined || vault.id === vaultId,
    );
    const hits: Array<MemoryVaultSearchHit> = [];
    for (const vault of vaults) {
      const { sections } = yield* readVaultSections(vaultDir(state, vault.id));
      for (const { section, score } of rankSections(sections, query).slice(0, 10)) {
        hits.push({
          vaultId: vault.id,
          path: section.path,
          heading: section.heading,
          excerpt: section.text.slice(0, 600),
          score: Math.round(score * 100) / 100,
        });
      }
    }
    return hits.toSorted((left, right) => right.score - left.score).slice(0, 20);
  });

  const selectUnlocked = Effect.fn("MemoryVaultService.select")(function* (input: {
    readonly threadId: string;
    readonly vaultId?: string | null;
    readonly access?: MemoryVaultAccess;
    readonly reset?: boolean;
  }) {
    const state = yield* readState;
    const current = selectionFor(state, input.threadId);
    const threads = { ...state.threads };
    if (input.reset) {
      delete threads[input.threadId];
    } else {
      const vaultId = input.vaultId === undefined ? current.vaultId : input.vaultId;
      if (vaultId !== null) yield* requireVault(state, vaultId);
      threads[input.threadId] = { vaultId, access: input.access ?? current.access };
    }
    const next = { ...state, threads };
    yield* writeState(next);
    return yield* overviewOf(next, input.threadId);
  });
  const select = (input: Parameters<typeof selectUnlocked>[0]) =>
    lock.withPermits(1)(selectUnlocked(input));

  const vaultForThread = Effect.fn("MemoryVaultService.vaultForThread")(function* (
    threadId: string,
  ) {
    const state = yield* readState;
    if (!state.settings.enabled) return yield* vaultError("Memory vaults are turned off.");
    const selection = selectionFor(state, threadId);
    if (selection.vaultId === null) {
      return yield* vaultError(
        "This thread has no memory vault. The user can choose one below the composer.",
      );
    }
    const vault = yield* requireVault(state, selection.vaultId);
    return { vaultId: selection.vaultId, name: vault.meta.name, access: selection.access };
  });

  const autoCreateFor = Effect.fn("MemoryVaultService.autoCreateFor")(function* (
    threadId: string,
    projectName: string | null,
  ) {
    const state = yield* readState;
    const name = projectName?.trim() || "General Development Memory";
    const existing = (yield* listVaults(state)).find((vault) => vault.name === name);
    const vaultId = existing?.id ?? (yield* createVault(state, name, true));
    return yield* selectUnlocked({ threadId, vaultId, access: state.settings.defaultAccess });
  }, lock.withPermits(1));

  const contextForTurn = Effect.fn("MemoryVaultService.contextForTurn")(
    function* (input: {
      readonly threadId: string;
      readonly userText: string;
      readonly projectName: string | null;
    }) {
      let state = yield* readState;
      if (!state.settings.enabled) return "";
      let selection = selectionFor(state, input.threadId);
      if (selection.vaultId === null && selection.inherited && state.settings.autoCreate) {
        // Named after the project, but stored outside it like every vault.
        yield* autoCreateFor(input.threadId, input.projectName);
        state = yield* readState;
        selection = selectionFor(state, input.threadId);
      }
      if (selection.vaultId === null) return "";
      const vault = yield* requireVault(state, selection.vaultId);
      if (selection.access === "reference") {
        return `Project memory vault "${vault.meta.name}" is available for reference with continuum_memory_search and continuum_memory_read. Nothing from it was added here.`;
      }
      const { files, sections } = yield* readVaultSections(vault.dir);
      const wholeVault = state.settings.retrieval === "full" || asksForWholeVault(input.userText);
      const chosen = selectVaultSections({
        sections,
        userText: input.userText,
        budgetChars: asksForWholeVault(input.userText)
          ? Math.max(state.settings.contextBudgetChars, 20_000)
          : state.settings.contextBudgetChars,
        full: wholeVault,
      });
      return renderVaultContext({
        vaultName: vault.meta.name,
        access: selection.access,
        autoUpdate: state.settings.autoUpdate,
        detailLevel: state.settings.detailLevel,
        files: files.map((file) => file.path),
        sections: chosen.sections,
        omittedSections: chosen.omitted,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Memory vault context was skipped for this turn.", cause).pipe(
        Effect.as(""),
      ),
    ),
  );

  const agentUpdate = Effect.fn("MemoryVaultService.agentUpdate")(function* (input: {
    readonly threadId: string;
    readonly path: string;
    readonly content: string;
    readonly mode: MemoryUpdateMode;
    readonly section?: string;
  }) {
    const target = yield* vaultForThread(input.threadId);
    if (target.access !== "read-write") {
      return yield* vaultError("This thread may read its memory vault but not change it.");
    }
    const dir = vaultDir(yield* readState, target.vaultId);
    const { text: content, redacted } = redactSecrets(input.content.trim());
    const existing = yield* fs
      .readFileString(path.join(dir, input.path))
      .pipe(Effect.orElseSucceed(() => ""));
    let next: string;
    if (input.mode === "replace_file" || existing === "") {
      next = `${content}\n`;
    } else if (input.mode === "append") {
      next = `${existing.trimEnd()}\n\n${content}\n`;
    } else {
      const heading = input.section?.trim();
      if (!heading) {
        return yield* vaultError("replace_section needs `section`, a heading in the file.");
      }
      next = replaceMarkdownSection(existing, heading, content);
    }
    yield* writeVaultFile(dir, input.path, next);
    return { vault: target.name, path: input.path, chars: next.length, redacted };
  }, lock.withPermits(1));

  return MemoryVaultService.of({
    overview,
    updateSettings,
    manage,
    readFile,
    writeFile,
    search,
    select,
    contextForTurn,
    vaultForThread,
    agentUpdate,
  });
});

export const layer = Layer.effect(MemoryVaultService, make);
