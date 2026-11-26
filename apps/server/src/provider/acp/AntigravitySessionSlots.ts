// @effect-diagnostics nodeBuiltinImport:off -- slot isolation manages per-file symlinks, NTFS links, and unlinked files with lstat.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_DISPOSABLE_DIR,
  ANTIGRAVITY_SESSIONS_DIR,
  ANTIGRAVITY_SESSION_SLOTS_DIR,
  ANTIGRAVITY_SHARED_APP_DATA_DIR,
  antigravityManagedPath,
  antigravityProfileRoot,
  isValidAntigravityNativeId,
  isValidAntigravitySlotId,
} from "./AntigravityProfilePaths.ts";
import { readAntigravityInvokeChildIds } from "./AntigravityChildWork.ts";
import {
  antigravityProfileSettings,
  authSupportError,
  type AntigravityAuthConfig,
  type AntigravityProfile,
} from "../antigravityAuthSupport.ts";

const SHARED_AUTH_FILES = ["antigravity-oauth-token", "acp_token.json"] as const;
const MCP_TOKENS_FILE = "mcp_oauth_tokens.json";

const hasCode = (error: unknown, ...codes: ReadonlyArray<string>) =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  codes.includes(error.code);

const linkFallbackReason = (error: unknown) =>
  hasCode(error, "EXDEV", "EPERM", "ENOTSUP", "ENOSYS", "EACCES");

const lstatOrUndefined = (filePath: string) =>
  NodeFSP.lstat(filePath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });

const statOrUndefined = (filePath: string) =>
  NodeFSP.stat(filePath).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  });

async function ensurePrivateDirectory(directory: string, platform: NodeJS.Platform) {
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await NodeFSP.lstat(directory)).isDirectory()) {
    throw new Error("Expected a managed Antigravity directory.");
  }
  if (platform !== "win32") await NodeFSP.chmod(directory, 0o700);
}

const profileIO = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => authSupportError(detail, cause) });

function linkMatches(existing: string | undefined, expected: string, junction: boolean) {
  if (existing === undefined) return false;
  return junction
    ? existing.replace(/[\\/]+$/, "") === expected.replace(/[\\/]+$/, "")
    : existing === expected;
}

async function symlinkPreservingExisting(
  source: string,
  target: string,
  type: "file" | "dir" | "junction",
) {
  await NodeFSP.symlink(source, target, type).catch(async (error: unknown) => {
    if (hasCode(error, "EEXIST")) {
      const current = await NodeFSP.readlink(target).catch(() => undefined);
      if (linkMatches(current, source, type === "junction")) return;
    }
    throw error;
  });
}

async function seedEmptyJsonFile(source: string, platform: NodeJS.Platform) {
  const temp = NodePath.join(
    NodePath.dirname(source),
    `.mcp_oauth_tokens.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const handle = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await handle.writeFile("{}\n", "utf8");
      if (platform !== "win32") await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await NodeFSP.link(temp, source).catch(async (error: unknown) => {
      if (hasCode(error, "EEXIST")) return;
      if (!linkFallbackReason(error)) throw error;
      await NodeFSP.writeFile(source, "{}\n", { flag: "wx", mode: 0o600 }).catch(
        (fallbackError: unknown) => {
          if (!hasCode(fallbackError, "EEXIST")) throw fallbackError;
        },
      );
    });
  } finally {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function ensurePosixFileSymlink(
  source: string,
  target: string,
  existing: NodeFS.Stats | undefined,
) {
  if (
    existing?.isSymbolicLink() &&
    (await NodeFSP.readlink(target).catch(() => undefined)) === source
  ) {
    return;
  }
  if (existing !== undefined) await NodeFSP.rm(target, { force: true });
  await symlinkPreservingExisting(source, target, "file");
}

// `agy` updates OAuth and MCP token files in place, so a per-file link shares refreshes across slots.
async function linkSharedFile(
  source: string,
  target: string,
  platform: NodeJS.Platform,
  options: { readonly seedEmptyJson: boolean; readonly removeWhenMissing: boolean },
) {
  let sourceEntry = await lstatOrUndefined(source);
  if (options.seedEmptyJson && sourceEntry === undefined) {
    await seedEmptyJsonFile(source, platform);
    sourceEntry = await lstatOrUndefined(source);
  }

  // Follow a user-configured canonical symlink (e.g. pointing to antigravity-cli).
  const sourceInfo = await statOrUndefined(source);
  const existing = await lstatOrUndefined(target);
  if (sourceInfo === undefined) {
    if (platform !== "win32" && options.seedEmptyJson && sourceEntry?.isSymbolicLink()) {
      await ensurePosixFileSymlink(source, target, existing);
      return;
    }
    if (existing !== undefined && (options.removeWhenMissing || existing.isSymbolicLink())) {
      await NodeFSP.rm(target, { force: true });
    }
    return;
  }
  if (!sourceInfo.isFile()) {
    throw new Error("Expected a regular Antigravity profile file.");
  }

  if (platform === "win32") {
    const canonicalSource = await NodeFSP.realpath(source);
    const canonicalInfo = await NodeFSP.lstat(canonicalSource, { bigint: true });
    if (!canonicalInfo.isFile()) throw new Error("Expected a regular Antigravity profile file.");
    const existingBigInt = await NodeFSP.lstat(target, { bigint: true }).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (
      existingBigInt !== undefined &&
      existingBigInt.isFile() &&
      canonicalInfo.ino !== 0n &&
      existingBigInt.dev === canonicalInfo.dev &&
      existingBigInt.ino === canonicalInfo.ino
    ) {
      return;
    }
    if (
      existingBigInt?.isSymbolicLink() &&
      (await NodeFSP.readlink(target).catch(() => undefined)) === canonicalSource
    ) {
      return;
    }
    if (existingBigInt !== undefined) await NodeFSP.rm(target, { force: true });
    // Never copy: agy refreshes tokens in place, so a copy would diverge from the canonical file.
    await NodeFSP.link(canonicalSource, target).catch(async (error: unknown) => {
      if (!linkFallbackReason(error)) throw error;
      await symlinkPreservingExisting(canonicalSource, target, "file");
    });
    return;
  }

  await ensurePosixFileSymlink(source, target, existing);
}

async function linkPluginData(source: string, target: string, platform: NodeJS.Platform) {
  const sourceEntry = await lstatOrUndefined(source);
  if (sourceEntry === undefined) {
    await ensurePrivateDirectory(source, platform);
  } else if (sourceEntry.isSymbolicLink()) {
    const resolved = await statOrUndefined(source);
    if (resolved === undefined || !resolved.isDirectory()) {
      throw new Error("Expected a managed Antigravity directory.");
    }
  } else if (!sourceEntry.isDirectory()) {
    throw new Error("Expected a managed Antigravity directory.");
  }
  const existing = await lstatOrUndefined(target);
  if (existing?.isDirectory()) {
    if ((await NodeFSP.readdir(target)).length > 0) return;
    await NodeFSP.rmdir(target);
  } else if (existing !== undefined) {
    if (
      existing.isSymbolicLink() &&
      linkMatches(
        await NodeFSP.readlink(target).catch(() => undefined),
        source,
        platform === "win32",
      )
    ) {
      return;
    }
    if (existing.isSymbolicLink() && platform === "win32") {
      await NodeFSP.rmdir(target).catch((error: unknown) => {
        if (!hasCode(error, "ENOTDIR")) throw error;
        return NodeFSP.rm(target, { force: true });
      });
    } else {
      await NodeFSP.rm(target, { force: true });
    }
  }
  await symlinkPreservingExisting(source, target, platform === "win32" ? "junction" : "dir");
}

const writeManagedFile = Effect.fn("Antigravity.writeManagedFile")(function* (
  filePath: string,
  contents: string,
) {
  const entry = yield* profileIO("Could not inspect the Antigravity profile file.", () =>
    lstatOrUndefined(filePath),
  );
  if (entry !== undefined && !entry.isFile()) {
    return yield* authSupportError("Expected a regular Antigravity profile file.");
  }
  yield* writeFileStringAtomically({ filePath, contents }).pipe(
    Effect.mapError((cause) =>
      authSupportError("Could not write the Antigravity profile file.", cause),
    ),
  );
});

export const prepareAntigravitySessionAppDataDir = Effect.fn("prepareAntigravitySessionAppDataDir")(
  function* (input: {
    readonly profile: AntigravityProfile;
    readonly auth?: AntigravityAuthConfig;
    readonly kind: "session" | "disposable";
    readonly slotId: string;
    readonly clearSummaryState?: boolean;
  }) {
    const path = yield* Path.Path;
    const { profile, kind, slotId } = input;
    if (!isValidAntigravitySlotId(slotId)) {
      return yield* authSupportError("Invalid Antigravity slot ID.");
    }
    const parentFolder = kind === "session" ? ANTIGRAVITY_SESSIONS_DIR : ANTIGRAVITY_DISPOSABLE_DIR;
    const appDataDir = `${parentFolder}/${slotId}`;
    const parentDirectory = path.join(profile.geminiHome, parentFolder);
    const directory = path.join(parentDirectory, slotId);

    yield* profileIO("Could not create the Antigravity session directory.", async () => {
      await ensurePrivateDirectory(parentDirectory, profile.platform);
      await ensurePrivateDirectory(directory, profile.platform);
      await ensurePrivateDirectory(path.join(directory, "conversations"), profile.platform);
    });

    yield* writeManagedFile(
      path.join(directory, "settings.json"),
      antigravityProfileSettings(input.auth),
    );

    yield* profileIO("Could not link shared Antigravity profile files.", async () => {
      for (const name of SHARED_AUTH_FILES) {
        await linkSharedFile(
          path.join(profile.acpDirectory, name),
          path.join(directory, name),
          profile.platform,
          { seedEmptyJson: false, removeWhenMissing: true },
        );
      }
      await linkSharedFile(
        path.join(profile.acpDirectory, "installation_id"),
        path.join(directory, "installation_id"),
        profile.platform,
        { seedEmptyJson: false, removeWhenMissing: false },
      );
      if (kind === "session") {
        await linkSharedFile(
          path.join(profile.acpDirectory, MCP_TOKENS_FILE),
          path.join(directory, MCP_TOKENS_FILE),
          profile.platform,
          { seedEmptyJson: true, removeWhenMissing: false },
        );
        await linkPluginData(
          path.join(profile.acpDirectory, "plugin_data"),
          path.join(directory, "plugin_data"),
          profile.platform,
        );
      }
      if (input.clearSummaryState) {
        for (const name of [
          "jetbox_summaries_proto.pb",
          "conversation_summaries.db",
          "conversation_summaries.db-wal",
          "conversation_summaries.db-shm",
          "conversation_summaries.db-journal",
        ]) {
          await NodeFSP.rm(path.join(directory, name), { force: true });
        }
        const cache = path.join(directory, "cache");
        const cacheEntry = await lstatOrUndefined(cache);
        if (cacheEntry !== undefined && !cacheEntry.isDirectory()) {
          throw new Error("Expected a managed Antigravity cache directory.");
        }
        if (cacheEntry !== undefined) {
          await NodeFSP.rm(path.join(cache, "conversation_metadata.json"), { force: true });
        }
      }
    });

    return { appDataDir, directory };
  },
);

export const writeAntigravitySessionSlot = Effect.fn("writeAntigravitySessionSlot")(function* (
  profileDirectory: string,
  sessionId: string,
  slotId: string,
) {
  if (!isValidAntigravityNativeId(sessionId) || !isValidAntigravitySlotId(slotId)) {
    return yield* authSupportError("Invalid Antigravity session or slot ID.");
  }
  const path = yield* Path.Path;
  const directory = path.join(profileDirectory, ANTIGRAVITY_SESSION_SLOTS_DIR);
  const platform = yield* HostProcess.Platform;
  yield* profileIO("Could not create the Antigravity session slot index.", () =>
    ensurePrivateDirectory(directory, platform),
  );
  return yield* Effect.asVoid(writeManagedFile(path.join(directory, sessionId), `${slotId}\n`));
});

async function copyManagedFile(source: string, destination: string, platform: NodeJS.Platform) {
  await NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
  if (platform !== "win32") await NodeFSP.chmod(destination, 0o600);
}

async function copyManagedTree(source: string, destination: string, platform: NodeJS.Platform) {
  await ensurePrivateDirectory(destination, platform);
  for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
    const childSource = NodePath.join(source, entry.name);
    const childDestination = NodePath.join(destination, entry.name);
    const info = await NodeFSP.lstat(childSource);
    if (entry.isDirectory() && info.isDirectory()) {
      await copyManagedTree(childSource, childDestination, platform);
    } else if (entry.isFile() && info.isFile()) {
      await copyManagedFile(childSource, childDestination, platform);
    }
  }
}

export const migrateLegacyAntigravitySession = Effect.fn("migrateLegacyAntigravitySession")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string;
    readonly slotId: string;
  }) {
    const { profileDirectory, sessionId, slotId } = input;
    const root = yield* Effect.promise(() => antigravityProfileRoot(profileDirectory));
    if (
      root === undefined ||
      !isValidAntigravityNativeId(sessionId) ||
      !isValidAntigravitySlotId(slotId)
    ) {
      return false;
    }
    const source = (segments: ReadonlyArray<string>, kind: "file" | "directory") =>
      antigravityManagedPath(root, [ANTIGRAVITY_SHARED_APP_DATA_DIR, ...segments], kind);
    const database = yield* Effect.promise(() =>
      source(["conversations", `${sessionId}.db`], "file"),
    );
    if (database === undefined) return false;

    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const sessionsDir = path.join(root, ANTIGRAVITY_SESSIONS_DIR);
    const directory = path.join(sessionsDir, slotId);
    const legacyArtifacts: Array<ReadonlyArray<string>> = [];
    let createdDirectory = false;

    yield* Effect.gen(function* () {
      yield* profileIO("Could not copy legacy Antigravity session files.", async () => {
        await ensurePrivateDirectory(sessionsDir, platform);
        await NodeFSP.mkdir(directory, { mode: 0o700 });
        createdDirectory = true;
        for (const folder of ["conversations", "brain", "annotations"]) {
          await ensurePrivateDirectory(path.join(directory, folder), platform);
        }

        let mtimeMs = database.info.mtimeMs;
        for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
          const segments = ["conversations", `${sessionId}${suffix}`];
          const entry = await source(segments, "file");
          if (entry === undefined) continue;
          if (suffix === ".db-wal") mtimeMs = Math.max(mtimeMs, entry.info.mtimeMs);
          await copyManagedFile(entry.path, path.join(directory, ...segments), platform);
          legacyArtifacts.push(segments);
        }
        const seconds = mtimeMs / 1000;
        await NodeFSP.utimes(
          path.join(directory, "conversations", `${sessionId}.db`),
          seconds,
          seconds,
        );

        const annotation = await source(["annotations", `${sessionId}.pbtxt`], "file");
        if (annotation !== undefined) {
          const segments = ["annotations", `${sessionId}.pbtxt`];
          await copyManagedFile(annotation.path, path.join(directory, ...segments), platform);
          legacyArtifacts.push(segments);
        }

        const brain = await source(["brain", sessionId], "directory");
        if (brain !== undefined) {
          const segments = ["brain", sessionId];
          await copyManagedTree(brain.path, path.join(directory, ...segments), platform);
          legacyArtifacts.push(segments);
        }

        const childIds = new Set<string>();
        for (const childId of readAntigravityInvokeChildIds(
          path.join(directory, "conversations", `${sessionId}.db`),
        )) {
          if (childId !== sessionId && isValidAntigravityNativeId(childId)) childIds.add(childId);
        }
        const subagents = await source(
          ["brain", sessionId, ".system_generated", "subagents"],
          "directory",
        );
        if (subagents !== undefined) {
          for (const child of await NodeFSP.readdir(subagents.path, { withFileTypes: true })) {
            const childId = child.name.slice(0, -5);
            if (
              child.isFile() &&
              child.name.endsWith(".json") &&
              childId !== sessionId &&
              isValidAntigravityNativeId(childId)
            ) {
              childIds.add(childId);
            }
          }
        }
        for (const childId of childIds) {
          const childBrain = await source(["brain", childId], "directory");
          if (childBrain !== undefined) {
            const segments = ["brain", childId];
            await copyManagedTree(childBrain.path, path.join(directory, ...segments), platform);
            legacyArtifacts.push(segments);
          }
        }
      });
      yield* writeAntigravitySessionSlot(root, sessionId, slotId);
    }).pipe(
      Effect.onError(() =>
        createdDirectory
          ? profileIO("Could not remove incomplete Antigravity migration directory.", () =>
              NodeFSP.rm(directory, { recursive: true, force: true }),
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
    );

    for (const segments of legacyArtifacts) {
      yield* profileIO("Could not remove migrated Antigravity artifact.", async () => {
        const entry = await source(segments, segments[0] === "brain" ? "directory" : "file");
        if (entry !== undefined) await NodeFSP.rm(entry.path, { recursive: true, force: true });
      }).pipe(Effect.catch((error) => Effect.logWarning(error.detail, { segments })));
    }
    return true;
  },
  Effect.uninterruptible,
);

export const clearAntigravitySessionAuthFiles = Effect.fn("clearAntigravitySessionAuthFiles")(
  function* (profileDirectory: string) {
    const path = yield* Path.Path;
    yield* profileIO("Could not clear Antigravity session sign-in files.", async () => {
      if ((await lstatOrUndefined(profileDirectory)) === undefined) return;
      const root = await NodeFSP.realpath(profileDirectory);
      const slotParents = [
        path.join(root, ANTIGRAVITY_SESSIONS_DIR),
        path.join(root, ANTIGRAVITY_DISPOSABLE_DIR),
      ];
      let firstError: unknown;
      try {
        for (const entry of await NodeFSP.readdir(root, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith(`${ANTIGRAVITY_DISPOSABLE_DIR}.old-`)) {
            slotParents.push(path.join(root, entry.name, "runtime"));
          }
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) firstError ??= error;
      }
      for (const directory of slotParents) {
        try {
          const parent = await lstatOrUndefined(directory);
          if (parent === undefined || !parent.isDirectory()) continue;
          for (const slot of await NodeFSP.readdir(directory, { withFileTypes: true })) {
            if (!slot.isDirectory()) continue;
            for (const name of SHARED_AUTH_FILES) {
              await NodeFSP.rm(path.join(directory, slot.name, name), { force: true }).catch(
                (error: unknown) => {
                  if (!hasCode(error, "ENOENT")) firstError ??= error;
                },
              );
            }
          }
        } catch (error) {
          if (!hasCode(error, "ENOENT")) firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    });
  },
);
