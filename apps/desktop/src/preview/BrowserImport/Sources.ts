/**
 * Importable browser sources.
 *
 * Each entry pins its own on-disk and keychain coordinates rather than
 * deriving them: Chromium forks do not agree on the convention. Helium, for
 * instance, uses the keychain service "Helium Storage Key" / account "Helium"
 * where Chrome and its closer relatives use "<Name> Safe Storage" / "<Name>".
 *
 * @module BrowserImportSources
 */
// @effect-diagnostics nodeBuiltinImport:off
import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  /** Platforms the definition's paths are valid for. */
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  readonly userDataDirectory: () => string;
  readonly keychainService: string;
  readonly keychainAccount: string;
}

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  {
    id: "helium",
    name: "Helium",
    platforms: ["darwin"],
    userDataDirectory: () =>
      NodePath.join(NodeOS.homedir(), "Library", "Application Support", "net.imput.helium"),
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
  },
];

const pathExists = (path: string): Promise<boolean> =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

/**
 * Tests the directory entry itself rather than whatever it points at.
 *
 * Chromium points `SingletonLock` at `<host>-<pid>`, a target that never
 * exists, so following the link reports a running browser as closed — exactly
 * backwards, and it would let an import read a live, mid-write database.
 */
const entryExists = (path: string): Promise<boolean> =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

export const cookieDatabasePath = (
  definition: BrowserImportSourceDefinition,
  profileDirectory: string,
): string => NodePath.join(definition.userDataDirectory(), profileDirectory, "Cookies");

/**
 * Profiles the source browser knows about, read from its `Local State`.
 *
 * Falls back to the `Default` directory when that file is unreadable or has no
 * profile cache: a browser that has only ever had one profile is the common
 * case, and failing the whole import over a missing display name would be
 * disproportionate.
 */
export async function listSourceProfiles(
  definition: BrowserImportSourceDefinition,
): Promise<ReadonlyArray<BrowserImportSourceProfile>> {
  const fallback: ReadonlyArray<BrowserImportSourceProfile> = [
    { directory: "Default", name: "Default" },
  ];
  try {
    const raw = await NodeFSP.readFile(
      NodePath.join(definition.userDataDirectory(), "Local State"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    const entries = Object.entries(parsed.profile?.info_cache ?? {});
    if (entries.length === 0) return fallback;
    return entries.map(([directory, info]) => ({
      directory,
      name: info.name?.trim() || directory,
    }));
  } catch {
    return fallback;
  }
}

/** Whether the browser is running, which leaves its cookie DB mid-write. */
export async function isSourceRunning(definition: BrowserImportSourceDefinition): Promise<boolean> {
  // Chromium writes a `SingletonLock` symlink for as long as an instance holds
  // the profile. Its presence is a far cheaper and more targeted signal than
  // scanning the process table for a name.
  return entryExists(NodePath.join(definition.userDataDirectory(), "SingletonLock"));
}

export async function isSourceInstalled(
  definition: BrowserImportSourceDefinition,
): Promise<boolean> {
  return pathExists(definition.userDataDirectory());
}
