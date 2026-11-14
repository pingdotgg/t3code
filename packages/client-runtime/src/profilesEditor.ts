import type { ProfilesSyncStatus } from "./state/profilesSync.ts";
import type {
  ClaudeProviderSettings,
  McpServersFile,
  Profile,
  ProfileProviderSettingsDriver,
  ProfilesFile,
  ProviderSettingsFile,
} from "@t3tools/contracts";

export const PROFILE_DRIVERS = ["claudeAgent", "codex", "pi"] as const;

export const PROFILE_DRIVER_LABELS: Record<ProfileProviderSettingsDriver, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  pi: "Pi",
};

const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function profileNameError(name: string, taken: ReadonlyArray<string>): string | null {
  if (name.length === 0) return "Enter a name.";
  if (name.length > 128) return "Use at most 128 characters.";
  if (!PROFILE_ID_PATTERN.test(name)) {
    return "Use letters, digits, - and _, starting with a letter or digit.";
  }
  if (taken.includes(name)) return "That name is taken.";
  return null;
}

export function mcpServerNameError(name: string, taken: ReadonlyArray<string>): string | null {
  if (/^t3[-_]?code/i.test(name)) return "Names starting with t3-code are T3's own.";
  return profileNameError(name, taken);
}

/** Matches the server schema, so the editor can say what is missing before saving. */
export function mcpServerError(server: {
  readonly url?: string;
  readonly command?: string;
}): string | null {
  if (server.command !== undefined)
    return server.command.trim() === "" ? "Enter a command, such as npx." : null;
  return /^https?:\/\/\S+$/.test(server.url ?? "")
    ? null
    : "Enter a full URL, such as https://example.com/mcp.";
}

export const EMPTY_MCP_SERVERS: McpServersFile = { mcpServers: {} };

export function profilesUsingMcpServer(file: ProfilesFile | null, name: string): string[] {
  return Object.entries(file?.profiles ?? {}).flatMap(([id, profile]) =>
    profile.mcpServers?.includes(name) ? [id] : [],
  );
}

/** Drops the empty argument lines a text box leaves while typing. */
export function cleanMcpServers(file: McpServersFile): McpServersFile {
  return {
    mcpServers: Object.fromEntries(
      Object.entries(file.mcpServers).map(([name, server]) => {
        if (!("command" in server) || server.args === undefined) return [name, server];
        // An empty line inside the list can be a deliberate empty argument.
        const args = [...server.args];
        while (args.at(-1) === "") args.pop();
        return [name, withKey(server, "args", args.length === 0 ? undefined : args)];
      }),
    ),
  };
}

/** Takes a deleted MCP server out of every profile that selected it. */
export function removeMcpServerRefs(file: ProfilesFile, name: string): ProfilesFile {
  return mapProfiles(file, (profile) =>
    profile.mcpServers?.includes(name)
      ? withKey(profile, "mcpServers", toggleInOptionalList(profile.mcpServers, name, false))
      : profile,
  );
}

export function uniqueName(base: string, taken: ReadonlyArray<string>): string {
  if (!taken.includes(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Sets `key`, or removes it when `value` is undefined, keeping the other keys. */
export function withKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
  next: T[K] | undefined,
): T {
  const { [key]: _removed, ...rest } = value;
  return (next === undefined ? rest : { ...rest, [key]: next }) as T;
}

/** Turns a name on or off in an ordered list; turning one on appends it. */
export function toggleInList(
  list: ReadonlyArray<string>,
  name: string,
  on: boolean,
): ReadonlyArray<string> {
  if (on) return list.includes(name) ? list : [...list, name];
  return list.filter((entry) => entry !== name);
}

/** Like `toggleInList`, for optional lists that are left out when empty. */
export function toggleInOptionalList(
  list: ReadonlyArray<string> | undefined,
  name: string,
  on: boolean,
): ReadonlyArray<string> | undefined {
  const next = toggleInList(list ?? [], name, on);
  return next.length === 0 ? undefined : next;
}

function mapProfiles(file: ProfilesFile, map: (profile: Profile) => Profile): ProfilesFile {
  return {
    ...file,
    profiles: Object.fromEntries(
      Object.entries(file.profiles).map(([id, profile]) => [id, map(profile)]),
    ),
  };
}

/** Renames a key while keeping its position, so lists keep their order. */
function renameKey<V>(record: Readonly<Record<string, V>>, from: string, to: string) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key === from ? to : key, value]),
  );
}

export function addProfile(file: ProfilesFile, id: string): ProfilesFile {
  return { ...file, profiles: { ...file.profiles, [id]: { prompts: [], skills: [] } } };
}

export function duplicateProfile(file: ProfilesFile, id: string, copyId: string): ProfilesFile {
  const source = file.profiles[id];
  return source === undefined
    ? file
    : { ...file, profiles: { ...file.profiles, [copyId]: source } };
}

export function renameProfile(file: ProfilesFile, from: string, to: string): ProfilesFile {
  return {
    ...file,
    ...(file.default === from ? { default: to } : {}),
    profiles: renameKey(file.profiles, from, to),
  };
}

export function deleteProfile(file: ProfilesFile, id: string): ProfilesFile {
  const { [id]: _removed, ...profiles } = file.profiles;
  const next = { ...file, profiles };
  return file.default === id ? withKey(next, "default", undefined) : next;
}

/** Points every profile using `from` at `to`, or back at the provider default when `to` is null. */
export function renameProviderSettingsRefs(
  file: ProfilesFile,
  driver: ProfileProviderSettingsDriver,
  from: string,
  to: string | null,
): ProfilesFile {
  return mapProfiles(file, (profile) => {
    if (profile.providerSettings?.[driver] !== from) return profile;
    const refs = withKey(profile.providerSettings, driver, to ?? undefined);
    return withKey(profile, "providerSettings", Object.keys(refs).length === 0 ? undefined : refs);
  });
}

export function renamePromptRefs(
  file: ProfilesFile,
  from: string,
  to: string | null,
): ProfilesFile {
  return mapProfiles(file, (profile) =>
    profile.prompts.includes(from)
      ? {
          ...profile,
          prompts:
            to === null
              ? profile.prompts.filter((name) => name !== from)
              : profile.prompts.map((name) => (name === from ? to : name)),
        }
      : profile,
  );
}

export function profilesUsingPrompt(file: ProfilesFile | null, name: string): string[] {
  return Object.entries(file?.profiles ?? {}).flatMap(([id, profile]) =>
    profile.prompts.includes(name) ? [id] : [],
  );
}

export function profilesUsingProviderSettings(
  file: ProfilesFile | null,
  driver: ProfileProviderSettingsDriver,
  name: string,
): string[] {
  return Object.entries(file?.profiles ?? {}).flatMap(([id, profile]) =>
    profile.providerSettings?.[driver] === name ? [id] : [],
  );
}

export function renameProviderSettings(
  file: ProviderSettingsFile,
  driver: ProfileProviderSettingsDriver,
  from: string,
  to: string | null,
): ProviderSettingsFile {
  const entries = file[driver] ?? {};
  const next =
    to === null
      ? Object.fromEntries(Object.entries(entries).filter(([name]) => name !== from))
      : renameKey(entries, from, to);
  return withKey(file, driver, Object.keys(next).length === 0 ? undefined : next);
}

export type TriState = "default" | "on" | "off";

export const triStateOf = (value: boolean | undefined): TriState =>
  value === undefined ? "default" : value ? "on" : "off";

export const booleanOfTriState = (state: TriState): boolean | undefined =>
  state === "default" ? undefined : state === "on";

/** Sets one `features.<name>` override; "default" removes it, and an empty map is left out. */
export function withFeature(
  features: Readonly<Record<string, boolean>> | undefined,
  name: string,
  state: TriState,
): Readonly<Record<string, boolean>> | undefined {
  const next = withKey({ ...features }, name, booleanOfTriState(state));
  return Object.keys(next).length === 0 ? undefined : next;
}

export interface SettingsOption {
  readonly name: string;
  readonly description?: string;
  /** Whether the provider reports it on by default here. */
  readonly enabled?: boolean;
  /** False only when a successful list confirms a stored name is missing. */
  readonly detected: boolean;
}

/** Detected names in the provider's order, then stored names it did not report. */
export function settingsOptions(
  detected:
    | ReadonlyArray<{
        readonly name: string;
        readonly description?: string;
        readonly enabled?: boolean;
      }>
    | undefined,
  stored: Iterable<string>,
  error?: string,
): SettingsOption[] {
  const options: SettingsOption[] = (detected ?? []).map((option) => ({
    ...option,
    detected: true,
  }));
  const seen = new Set(options.map(({ name }) => name));
  for (const name of [...stored].sort()) {
    if (!seen.has(name)) {
      seen.add(name);
      options.push({ name, detected: Boolean(error) && (detected?.length ?? 0) === 0 });
    }
  }
  return options;
}

/** The JSON object shape of Claude `settings` and Codex `config`. */
export type JsonObject = NonNullable<ClaudeProviderSettings["settings"]>;

export type JsonObjectParse =
  | { readonly ok: true; readonly value: JsonObject | undefined }
  | { readonly ok: false; readonly error: string };

/** Blank is no advanced keys; anything else must be a JSON object. */
export function parseJsonObject(text: string): JsonObjectParse {
  if (text.trim() === "") return { ok: true, value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Enter a JSON object, like { "key": true }.' };
  }
  // JSON.parse only produces JSON values.
  return { ok: true, value: Object.keys(value).length === 0 ? undefined : (value as JsonObject) };
}

export const formatJsonObject = (value: JsonObject | undefined): string =>
  value === undefined ? "" : JSON.stringify(value, null, 2);

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export interface PromptsDraft {
  readonly contents: Readonly<Record<string, string>>;
}

/** The prompt writes that turn `saved` into `draft`. Renames and deletes are saved on their own. */
export function promptUpserts(
  saved: ReadonlyArray<{ readonly name: string; readonly content: string }>,
  draft: Readonly<Record<string, string>>,
): Array<{ name: string; content: string }> {
  const savedContent = new Map(saved.map(({ name, content }) => [name, content]));
  return Object.entries(draft).flatMap(([name, content]) =>
    savedContent.get(name) === content ? [] : [{ name, content }],
  );
}

/** An unsaved edit of one section, with the saved value it started from. */
export interface SectionDraft<T> {
  readonly base: T;
  readonly value: T;
}

export interface SectionDraftView<T> {
  readonly value: T;
  readonly dirty: boolean;
  /** The saved value changed since the edit began, so saving would overwrite that change. */
  readonly stale: boolean;
}

export function viewDraft<T>(saved: T, draft: SectionDraft<T> | null): SectionDraftView<T> {
  if (draft === null || sameValue(draft.base, draft.value)) {
    return { value: saved, dirty: false, stale: false };
  }
  return { value: draft.value, dirty: true, stale: !sameValue(draft.base, saved) };
}

export function editDraft<T>(saved: T, draft: SectionDraft<T> | null, next: T): SectionDraft<T> {
  return {
    base: viewDraft(saved, draft).dirty && draft !== null ? draft.base : saved,
    value: next,
  };
}

export function syncStatusText(input: {
  readonly connected: boolean;
  readonly canWrite: boolean;
  readonly status: ProfilesSyncStatus | undefined;
}): { readonly text: string; readonly tone: "muted" | "warning" | "error" } {
  if (!input.connected) return { text: "Not connected", tone: "muted" };
  if (!input.canWrite) return { text: "No permission to change settings", tone: "muted" };
  const { status } = input;
  if (status === undefined) return { text: "Not synced yet", tone: "muted" };
  switch (status.kind) {
    case "inSync":
      return { text: `In sync, revision ${status.revision}`, tone: "muted" };
    case "updated":
      return { text: `Updated just now, revision ${status.revision}`, tone: "muted" };
    case "backup":
      return { text: `Updated; its own changes were saved to ${status.path}`, tone: "warning" };
    case "failed":
      return { text: `Failed: ${status.message}`, tone: "error" };
    case "off":
      return { text: `Sync off, revision ${status.revision}`, tone: "muted" };
    case "unsupported":
      return { text: "Its T3 version does not sync profiles", tone: "muted" };
  }
}
