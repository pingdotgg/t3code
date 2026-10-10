/**
 * InstructionManager - changes instruction files and who reads them.
 *
 * Every write starts from the id the client sent, which `InstructionCatalog.resolve` looks up in
 * the table again, so a client can only reach files the table names, and only the files of a
 * registered project's folder, which the catalog checks. Writes run one request at a time.
 *
 * - A file's text is replaced at its real path behind any links, by temp file and rename, and only
 *   if its revision is still the one the client read.
 * - An agent reads the Global file (the one every project shares) because a link at its own home
 *   file points at it, or, for Claude, because its CLAUDE.md imports it. Both are made without
 *   replacing anything: a link with a bare create, an import line by adding text. An agent that
 *   already has a file of its own is moved over with `adopt`, which keeps that file's text in the
 *   Global file first.
 * - The only writes that take a real file are `adopt` (its text is kept first), `share` (a
 *   rename, refused when AGENTS.md exists; or a merge, where CLAUDE.md's text is written to the end
 *   of AGENTS.md before CLAUDE.md goes) and `delete`.
 *
 * @module InstructionManager
 */
import {
  InstructionError,
  ProviderDriverKind,
  type ClaudeInstructionSettingInput,
  type InstructionAdoptInput,
  type InstructionAgentsInput,
  type InstructionAgentsResult,
  type InstructionDeleteInput,
  type InstructionShareInput,
  type InstructionWriteInput,
  type InstructionWriteResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import { editJsoncFile, readSettingsText } from "../skills/JsoncSettings.ts";
import { excludeNewFile } from "../skills/SkillGitExclude.ts";
import { removeLink } from "../skills/SkillLinks.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  addAgentsMdImport,
  claudeInstructionChanges,
  parseSettingsJson,
  removeAgentsMdImport,
  type AgentsMdImportTarget,
} from "./ClaudeInstructionSetting.ts";
import * as InstructionCatalog from "./InstructionCatalog.ts";
import {
  INSTRUCTION_MAX_BYTES,
  inspect,
  readText,
  sha256,
  writeTargetOf,
} from "./InstructionFileIO.ts";
import { createFileLink, replaceWithLink } from "./InstructionLinks.ts";

type AgentResult = InstructionAgentsResult["results"][number];

const encoder = new TextEncoder();

const LIMIT_MESSAGE = "Instruction files can be at most 1 MB.";

/**
 * The text that adopting an agent's own file adds to the Global file: the agent's text under a
 * heading with the agent's name. Nothing is added when the Global file has that text already.
 */
export const adoptedText = (sharedText: string, agentName: string, agentText: string) => {
  const own = agentText.trim();
  if (own === "" || sharedText.trim() === own) return sharedText;
  const section = `## From ${agentName}\n\n${own}\n`;
  if (sharedText.includes(section)) return sharedText;
  if (sharedText === "") return section;
  return `${sharedText}${sharedText.endsWith("\n") ? "" : "\n"}\n${section}`;
};

export class InstructionManager extends Context.Service<
  InstructionManager,
  {
    /**
     * Replace the text of a file, or create it. `expectedRevision` is the revision that was read,
     * or null for a file that must not exist yet.
     */
    readonly write: (
      input: InstructionWriteInput,
    ) => Effect.Effect<InstructionWriteResult, InstructionError>;
    /**
     * Make each agent read the Global file: a link at its own home file, or for
     * Claude an import line. `"all"` means every enabled agent. An agent is named by its
     * instance id, or by its driver kind to mean every instance of that driver when no instance
     * has that id.
     */
    readonly enable: (
      input: InstructionAgentsInput,
    ) => Effect.Effect<InstructionAgentsResult, InstructionError>;
    /** Stop each agent reading the Global file by removing its link or import line. */
    readonly disable: (
      input: InstructionAgentsInput,
    ) => Effect.Effect<InstructionAgentsResult, InstructionError>;
    /** Set Claude's "Project instructions" setting; null goes back to Claude's default. */
    readonly setClaudeSetting: (
      input: ClaudeInstructionSettingInput,
    ) => Effect.Effect<void, InstructionError>;
    /**
     * Rename a project's CLAUDE.md to AGENTS.md, when it has no AGENTS.md; or with `merge`, add its
     * text to the end of the project's AGENTS.md and delete it.
     */
    readonly share: (input: InstructionShareInput) => Effect.Effect<void, InstructionError>;
    /** Add an agent's own text to the Global file, then make the agent's file a link to it. */
    readonly adopt: (input: InstructionAdoptInput) => Effect.Effect<void, InstructionError>;
    /** Delete an instruction file. A link is removed and what it points at stays. */
    readonly delete: (input: InstructionDeleteInput) => Effect.Effect<void, InstructionError>;
  }
>()("t3/instructions/InstructionManager") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const catalog = yield* InstructionCatalog.InstructionCatalog;
  const writeLock = yield* Semaphore.make(1);
  const fileSystemContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess
  >();

  const inspectAt = (file: string) => inspect(file).pipe(Effect.provideContext(fileSystemContext));
  const readTextAt = (file: string) =>
    readText(file).pipe(Effect.provideContext(fileSystemContext));
  const writeTargetAt = (file: string) =>
    writeTargetOf(file).pipe(Effect.provideContext(fileSystemContext));

  /**
   * Turns a failed file operation into an error a client can word, with the platform error kept
   * as its cause. A refused permission is `denied`, the file being off limits; any other failure
   * is `failed`, which is still a reason the client can show rather than a defect.
   */
  const guard = <A, R>(
    effect: Effect.Effect<A, PlatformError.PlatformError, R>,
    errors: {
      readonly denied: (cause: PlatformError.PlatformError) => InstructionError;
      readonly failed: (cause: PlatformError.PlatformError) => InstructionError;
    },
  ) =>
    effect.pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            cause.reason._tag === "PermissionDenied" ? errors.denied(cause) : errors.failed(cause),
          ),
      }),
    );

  /** Writing, renaming or removing `file`: off limits when the system refuses, else `writeFailed`. */
  const whenWriting = (file: string) => ({
    denied: (cause: PlatformError.PlatformError) =>
      new InstructionError({
        reason: "readOnly",
        message: `T3 Code isn't allowed to change ${path.basename(file)}.`,
        cause,
      }),
    failed: (cause: PlatformError.PlatformError) =>
      new InstructionError({
        reason: "writeFailed",
        message: `T3 Code couldn't change ${path.basename(file)}.`,
        cause,
      }),
  });

  /** Linking `file`: every failure of it is `linkFailed`, which the client explains. */
  const whenLinking = (file: string) => {
    const linkFailed = (cause: PlatformError.PlatformError) =>
      new InstructionError({
        reason: "linkFailed",
        message: `T3 Code couldn't link ${path.basename(file)}. Links need permission on this system.`,
        cause,
      });
    return { denied: linkFailed, failed: linkFailed };
  };

  const invalidSettings = new InstructionError({
    reason: "invalidSettings",
    message: "Claude's settings.json isn't valid JSON, so T3 Code left it alone.",
  });

  /** A file keeps its permissions through a write; a new one gets the default. */
  const writeText = (file: string, contents: string) =>
    guard(
      Effect.gen(function* () {
        const mode = yield* fileSystem.stat(file).pipe(
          Effect.map((info) => info.mode & 0o777),
          Effect.orElseSucceed(() => undefined),
        );
        yield* writeFileStringAtomically({
          filePath: file,
          contents,
          ...(mode === undefined ? {} : { mode }),
        });
      }).pipe(Effect.provideContext(fileSystemContext)),
      whenWriting(file),
    );

  const importTargetOf = (
    claudeMd: string,
    view: InstructionCatalog.SharedView,
  ): AgentsMdImportTarget => ({
    path,
    agentsMdPath: view.file.path,
    claudeMdDirectory: path.dirname(claudeMd),
    homeDirectory: view.homeDirectory,
  });

  // --- write ---------------------------------------------------------------------------------

  const write: InstructionManager["Service"]["write"] = Effect.fn("InstructionManager.write")(
    function* (input) {
      return yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* catalog.resolve(input);
          if (entry.readOnly) {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "That file is set by your organization.",
            });
          }
          const bytes = encoder.encode(input.contents);
          if (bytes.byteLength > INSTRUCTION_MAX_BYTES) {
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          }
          const target = yield* writeTargetAt(entry.path);
          const current = yield* readTextAt(target);
          if (current._tag === "TooLarge")
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          if (current._tag === "Unreadable") {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "T3 Code can't read that file as text.",
            });
          }
          if (current._tag === "Missing" && input.expectedRevision !== null) {
            return yield* new InstructionError({
              reason: "changedOnDisk",
              message: "That file changed on disk. Reload it first.",
            });
          }
          if (current._tag === "Read") {
            if (input.expectedRevision === null) {
              return yield* new InstructionError({
                reason: "exists",
                message: "That file already exists.",
              });
            }
            if (input.expectedRevision !== current.revision) {
              return yield* new InstructionError({
                reason: "changedOnDisk",
                message: "That file changed on disk. Reload it first.",
              });
            }
          }
          yield* writeText(target, input.contents);
          // CLAUDE.local.md is the user's own, not the repository's: a new one stays out of git, as
          // Claude Code does for its local settings.
          if (current._tag === "Missing" && entry.kind === "claudeLocal") {
            yield* excludeNewFile({
              projectRoot: input.cwd ?? path.dirname(entry.path),
              file: entry.path,
            }).pipe(
              Effect.provideContext(fileSystemContext),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("could not keep CLAUDE.local.md out of git", {
                      file: entry.path,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
          return { id: input.id, revision: sha256(bytes) };
        }),
      );
    },
  );

  // --- enable and disable ----------------------------------------------------------------------

  const unchanged = (reach: InstructionCatalog.AgentReach, reason?: string): AgentResult => ({
    instanceId: reach.instanceId,
    outcome: "unchanged",
    ...(reason === undefined ? {} : { reason }),
  });
  const changed = (reach: InstructionCatalog.AgentReach): AgentResult => ({
    instanceId: reach.instanceId,
    outcome: "changed",
  });
  const failed = (reach: InstructionCatalog.AgentReach, reason: string): AgentResult => ({
    instanceId: reach.instanceId,
    outcome: "failed",
    reason,
  });

  /** An empty shared file is made first, so a link to it works as soon as it exists. */
  const ensureSharedFile = Effect.fnUntraced(function* (view: InstructionCatalog.SharedView) {
    if (view.file.exists) return;
    const target = yield* writeTargetAt(view.file.path);
    if ((yield* readTextAt(target))._tag === "Missing") {
      yield* writeText(target, "");
    }
  });

  const enableOne = Effect.fnUntraced(function* (
    reach: InstructionCatalog.AgentReach,
    view: InstructionCatalog.SharedView,
  ) {
    if (reach.state !== "none") return unchanged(reach);
    if (reach.reason === "ownFile") {
      return failed(
        reach,
        `${reach.displayName} has its own instructions. Use Global instead first.`,
      );
    }
    yield* ensureSharedFile(view);

    if (reach.join === "import") {
      const target = yield* writeTargetAt(reach.joinPath);
      const current = yield* readTextAt(target);
      if (current._tag === "TooLarge" || current._tag === "Unreadable") {
        return failed(reach, `T3 Code couldn't read ${path.basename(reach.joinPath)}.`);
      }
      const text = current._tag === "Read" ? current.text : "";
      const updated = addAgentsMdImport(text, importTargetOf(reach.joinPath, view));
      if (updated === text) return unchanged(reach);
      if (encoder.encode(updated).byteLength > INSTRUCTION_MAX_BYTES) {
        return failed(reach, LIMIT_MESSAGE);
      }
      yield* writeText(target, updated);
      return changed(reach);
    }

    const result = yield* createFileLink({ link: reach.joinPath, target: view.file.path }).pipe(
      Effect.provideContext(fileSystemContext),
      Effect.catchTags({ PlatformError: () => Effect.succeed("failed" as const) }),
    );
    if (result === "created") return changed(reach);
    if (result === "unchanged") return unchanged(reach);
    if (result === "taken") {
      return failed(reach, `Something else is already at ${path.basename(reach.joinPath)}.`);
    }
    return failed(
      reach,
      result === "notAllowed"
        ? "T3 Code isn't allowed to make links here."
        : "T3 Code couldn't make the link.",
    );
  });

  const disableOne = Effect.fnUntraced(function* (
    reach: InstructionCatalog.AgentReach,
    view: InstructionCatalog.SharedView,
    explicit: boolean,
  ) {
    if (reach.state === "none") return unchanged(reach);
    if (reach.state === "direct") {
      const reason = `${reach.displayName} reads the Global instructions where they are.`;
      return explicit ? failed(reach, reason) : unchanged(reach, reason);
    }

    if (reach.state === "import") {
      const target = yield* writeTargetAt(reach.joinPath);
      const current = yield* readTextAt(target);
      if (current._tag !== "Read") {
        return failed(reach, `T3 Code couldn't read ${path.basename(reach.joinPath)}.`);
      }
      const updated = removeAgentsMdImport(current.text, importTargetOf(reach.joinPath, view));
      if (updated === current.text) return unchanged(reach);
      const facts = yield* inspectAt(reach.joinPath);
      // The line was all the file held and the file is not a link: nothing is left worth keeping.
      if (updated.trim() === "" && facts.linkTarget === undefined) {
        yield* guard(fileSystem.remove(reach.joinPath), whenWriting(reach.joinPath));
      } else {
        yield* writeText(target, updated);
      }
      return changed(reach);
    }

    const links = reach.via.filter((entry) => entry.own && entry.kind === "link");
    if (links.length === 0) {
      return failed(
        reach,
        `${reach.displayName} reads the Global instructions through another agent's file.`,
      );
    }
    let removed = false;
    for (const link of links) {
      const written = yield* fileSystem.readLink(link.path).pipe(Effect.option);
      if (Option.isNone(written)) continue;
      const result = yield* removeLink({ path: link.path, expectedTarget: written.value }).pipe(
        Effect.provideContext(fileSystemContext),
        Effect.catchTags({ SkillLinkError: () => Effect.succeed("failed" as const) }),
      );
      if (result === "failed" || result === "changed") {
        return failed(reach, "The link changed, so it was left alone.");
      }
      removed = removed || result === "removed";
    }
    return removed ? changed(reach) : unchanged(reach);
  });

  /** Looks up the agents asked for among those with a home file; a name that matches none fails. */
  const pickAgents = (
    view: InstructionCatalog.SharedView,
    agents: InstructionAgentsInput["agents"],
  ) => {
    const picked = new Map<ProviderInstanceId, InstructionCatalog.AgentReach>();
    const unknown: ProviderInstanceId[] = [];
    if (agents === "all") {
      for (const reach of view.agents) picked.set(reach.instanceId, reach);
      return { picked, unknown };
    }
    for (const name of agents) {
      const driver = ProviderDriverKind.make(name);
      const byId = view.agents.filter((reach) => reach.instanceId === name);
      const matches =
        byId.length > 0 ? byId : view.agents.filter((reach) => reach.driver === driver);
      if (matches.length === 0) unknown.push(name);
      for (const reach of matches) picked.set(reach.instanceId, reach);
    }
    return { picked, unknown };
  };

  const changeAgents = (
    input: InstructionAgentsInput,
    change: (
      reach: InstructionCatalog.AgentReach,
      view: InstructionCatalog.SharedView,
    ) => Effect.Effect<AgentResult, InstructionError>,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const entry = yield* catalog.resolve(input);
        if (entry.scope !== "global" || entry.kind !== "shared") {
          return yield* new InstructionError({
            reason: "unknownEntry",
            message: "Only the Global instructions can be turned on or off.",
          });
        }
        const view = yield* catalog.shared;
        const { picked, unknown } = pickAgents(view, input.agents);
        const results: AgentResult[] = unknown.map((instanceId) => ({
          instanceId,
          outcome: "failed",
          reason: "That agent isn't enabled in this environment.",
        }));
        for (const reach of picked.values()) results.push(yield* change(reach, view));
        return { results } satisfies InstructionAgentsResult;
      }),
    );

  // --- Claude's setting ------------------------------------------------------------------------

  const setClaudeSetting: InstructionManager["Service"]["setClaudeSetting"] = Effect.fn(
    "InstructionManager.setClaudeSetting",
  )(function* (input) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const view = yield* catalog.shared;
        const claude = view.agents.find(
          (reach) => reach.instanceId === input.instanceId && reach.driver === "claudeAgent",
        );
        if (claude === undefined) {
          return yield* new InstructionError({
            reason: "unknownEntry",
            message: "That isn't a Claude agent in this environment.",
          });
        }
        const file = path.join(claude.directory, "settings.json");
        const text = yield* readSettingsText(file).pipe(Effect.provideContext(fileSystemContext));
        // A missing file is an empty object; one Claude couldn't read is never written over.
        const settings = text === undefined || text.trim() === "" ? {} : parseSettingsJson(text);
        if (settings === undefined) return yield* invalidSettings;
        // Nothing to take away from a file that isn't there.
        if (text === undefined && input.value === null) return;
        const result = yield* editJsoncFile({
          file,
          changes: claudeInstructionChanges(settings, input.value),
        }).pipe(Effect.provideContext(fileSystemContext));
        if (result === "invalid") return yield* invalidSettings;
        if (result === "failed") {
          return yield* new InstructionError({
            reason: "readOnly",
            message: `T3 Code isn't allowed to change ${path.basename(file)}.`,
          });
        }
      }),
    );
  });

  // --- share, adopt, delete --------------------------------------------------------------------

  const share: InstructionManager["Service"]["share"] = Effect.fn("InstructionManager.share")(
    function* (input) {
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* catalog.resolve(input);
          if (entry.kind !== "claude" || entry.relativePath !== "CLAUDE.md") {
            return yield* new InstructionError({
              reason: "unknownEntry",
              message: "Only a project's CLAUDE.md can be shared.",
            });
          }
          const from = yield* inspectAt(entry.path);
          if (!from.isFile)
            return yield* new InstructionError({
              reason: "notFound",
              message: "That file doesn't exist.",
            });
          const agentsMd = path.join(path.dirname(entry.path), "AGENTS.md");
          const into = yield* inspectAt(agentsMd);
          if (!input.merge) {
            if (into.present)
              return yield* new InstructionError({
                reason: "exists",
                message: "This project already has an AGENTS.md.",
              });
            return yield* guard(fileSystem.rename(entry.path, agentsMd), whenWriting(agentsMd));
          }
          if (!into.isFile) {
            return yield* new InstructionError({
              reason: "notFound",
              message: "This project has no AGENTS.md to merge into.",
            });
          }
          // AGENTS.md is a link to this very file, so deleting the file would take AGENTS.md too.
          if (from.linkTarget === undefined && into.real === from.real) {
            return yield* new InstructionError({
              reason: "exists",
              message: "AGENTS.md is a link to CLAUDE.md.",
            });
          }

          const claudeText = yield* readTextAt(entry.path);
          if (claudeText._tag === "TooLarge")
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          if (claudeText._tag !== "Read") {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "T3 Code can't read that file as text.",
            });
          }
          const agentsTarget = yield* writeTargetAt(agentsMd);
          const agentsText = yield* readTextAt(agentsTarget);
          if (agentsText._tag === "TooLarge")
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          if (agentsText._tag !== "Read") {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "T3 Code can't read AGENTS.md as text.",
            });
          }

          // A line that imports AGENTS.md would only point AGENTS.md at itself, so it doesn't move.
          const view = yield* catalog.shared;
          const own = removeAgentsMdImport(claudeText.text, {
            path,
            agentsMdPath: agentsMd,
            claudeMdDirectory: path.dirname(entry.path),
            homeDirectory: view.homeDirectory,
          }).trim();
          if (own !== "" && !agentsText.text.includes(own)) {
            const joined =
              agentsText.text.trim() === ""
                ? `${own}\n`
                : `${agentsText.text}${agentsText.text.endsWith("\n") ? "" : "\n"}\n${own}\n`;
            if (encoder.encode(joined).byteLength > INSTRUCTION_MAX_BYTES) {
              return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
            }
            yield* writeText(agentsTarget, joined);
          }
          // The text is in AGENTS.md now, so CLAUDE.md can go. A link goes and what it points at stays.
          yield* guard(fileSystem.remove(entry.path), whenWriting(entry.path));
        }),
      );
    },
  );

  const adopt: InstructionManager["Service"]["adopt"] = Effect.fn("InstructionManager.adopt")(
    function* (input) {
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* catalog.resolve(input);
          if (entry.kind !== "agentOwn" || entry.owner === undefined) {
            return yield* new InstructionError({
              reason: "unknownEntry",
              message: "Only an agent's own instructions can be moved.",
            });
          }
          const view = yield* catalog.shared;
          const reach = view.agents.find((candidate) => candidate.instanceId === entry.owner);
          if (reach === undefined) {
            return yield* new InstructionError({
              reason: "unknownEntry",
              message: "That agent isn't enabled in this environment.",
            });
          }
          // Nothing of its own to keep: it already reads the shared file, or has no file.
          if (reach.ownFile === undefined) {
            if (reach.state !== "none") return;
            return yield* new InstructionError({
              reason: "notFound",
              message: "That agent has no instructions of its own.",
            });
          }
          const ownFile = reach.ownFile;
          const own = yield* readTextAt(ownFile);
          if (own._tag === "TooLarge")
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          if (own._tag !== "Read") {
            return yield* new InstructionError({
              reason: "notFound",
              message: "T3 Code can't read that agent's instructions.",
            });
          }
          const before = yield* inspectAt(ownFile);

          const sharedTarget = yield* writeTargetAt(view.file.path);
          const shared = yield* readTextAt(sharedTarget);
          if (shared._tag === "TooLarge")
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          if (shared._tag === "Unreadable") {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "T3 Code can't read the Global instructions as text.",
            });
          }
          const sharedText = shared._tag === "Read" ? shared.text : "";
          const merged = adoptedText(sharedText, reach.displayName, own.text);
          const mergedBytes = encoder.encode(merged);
          if (mergedBytes.byteLength > INSTRUCTION_MAX_BYTES) {
            return yield* new InstructionError({ reason: "tooLarge", message: LIMIT_MESSAGE });
          }
          if (shared._tag === "Missing" || merged !== sharedText) {
            yield* writeText(sharedTarget, merged);
          }

          // The agent's text is in the Global file now; its file can become the link.
          const replaced = yield* guard(
            replaceWithLink({
              file: ownFile,
              target: view.file.path,
              stillSame: Effect.gen(function* () {
                const now = yield* inspectAt(ownFile);
                const text = yield* readTextAt(ownFile);
                return (
                  now.linkTarget === before.linkTarget &&
                  text._tag === "Read" &&
                  text.revision === own.revision
                );
              }),
            }).pipe(Effect.provideContext(fileSystemContext)),
            whenLinking(ownFile),
          );
          if (!replaced) {
            return yield* new InstructionError({
              reason: "changedOnDisk",
              message: "That file changed on disk. Nothing was linked.",
            });
          }
        }),
      );
    },
  );

  const remove: InstructionManager["Service"]["delete"] = Effect.fn("InstructionManager.delete")(
    function* (input) {
      yield* writeLock.withPermits(1)(
        Effect.gen(function* () {
          const entry = yield* catalog.resolve(input);
          if (entry.readOnly) {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "That file is set by your organization.",
            });
          }
          if (entry.kind === "shared") {
            return yield* new InstructionError({
              reason: "readOnly",
              message: "AGENTS.md files can't be deleted here.",
            });
          }
          const facts = yield* inspectAt(entry.path);
          if (!facts.present)
            return yield* new InstructionError({
              reason: "notFound",
              message: "That file doesn't exist.",
            });
          if (!facts.isFile && facts.linkTarget === undefined) {
            return yield* new InstructionError({
              reason: "unknownEntry",
              message: "That isn't a file.",
            });
          }
          // A non-recursive remove: a link goes and its target stays, a file goes, a folder fails.
          yield* guard(fileSystem.remove(entry.path), whenWriting(entry.path));
        }),
      );
    },
  );

  return InstructionManager.of({
    write,
    enable: Effect.fn("InstructionManager.enable")(function* (input) {
      return yield* changeAgents(input, (reach, view) => enableOne(reach, view));
    }),
    disable: Effect.fn("InstructionManager.disable")(function* (input) {
      return yield* changeAgents(input, (reach, view) =>
        disableOne(reach, view, input.agents !== "all"),
      );
    }),
    setClaudeSetting,
    share,
    adopt,
    delete: remove,
  });
});

export const layer = Layer.effect(InstructionManager, make);
