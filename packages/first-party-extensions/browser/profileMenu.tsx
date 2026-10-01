/**
 * The page menu's profile group — the package counterpart of the native
 * "Profile: <name>" heading with Clear cookies / Clear cache, plus opening
 * the page in another profile and the settings "Import from" flow. Each
 * control rides its own `t3.browser/profiles` grant; a refusal names the
 * missing grant (or desktop-required) in the group's note or the status
 * line. Choosing an action closes the menu, as native's items do, so a host
 * confirmation it raises is never under the menu; its progress and result go
 * to the status line as static text — no spinner.
 */
import { Tooltip } from "@t3tools/extension-sdk/authoring";
import { bindApi, bindStreamApi } from "@t3tools/extension-sdk/capabilities";
import {
  BROWSER_PROFILES,
  browserProfilesApi,
  type BrowserImportSourceSummary,
  type BrowserProfileChange,
  type BrowserSession,
} from "@t3tools/extension-sdk/catalogue";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import { resolveUiKit, type ClientUiKit } from "@t3tools/extension-sdk/ui";
import { satisfiesSemverRange } from "@t3tools/shared/semver";
import { useEffect, useState, useSyncExternalStore } from "react";

import {
  clearResultMessage,
  importableSources,
  importResultMessage,
  profileBadgeName,
  profileFailureMessage,
  profileLabel,
  sessionProfileId,
  type ProfileListStore,
} from "./profiles.js";

/** `t3.browser/profiles` 1.1.0 added the `changes` stream. */
const CHANGES_RANGE = "^1.1.0";

/**
 * The profiles API at its 1.0.0 baseline, plus `watch`: the `changes` stream
 * when the host's selected provider serves it, else null.
 */
export const bindProfilesApi = (
  host: Pick<ClientHost, "invokeApi" | "subscribeApi" | "discoverApis">,
  context: ViewContext,
) => ({
  ...bindApi(browserProfilesApi, host, context),
  async watch(signal: AbortSignal): Promise<AsyncIterable<BrowserProfileChange> | null> {
    const selected = (await host.discoverApis(context, signal)).find(
      (api) => api.id === BROWSER_PROFILES && api.selected,
    );
    if (selected === undefined || !satisfiesSemverRange(selected.version, CHANGES_RANGE)) {
      return null;
    }
    const frames = bindStreamApi(browserProfilesApi, host, context, CHANGES_RANGE).subscribe(
      "changes",
      {},
      signal,
    );
    return (async function* () {
      for await (const frame of frames) {
        if (frame.type === "closed") return;
        yield frame.value;
      }
    })();
  },
});
type ProfilesApi = ReturnType<typeof bindProfilesApi>;

const useProfileList = (profiles: ProfileListStore) =>
  useSyncExternalStore(profiles.subscribe, profiles.getSnapshot);

const muted = "var(--t3-browser-muted-foreground, var(--muted-foreground, #667085))";
const border = "1px solid var(--t3-browser-border, var(--border, #dfe3e8))";
const control = {
  font: "inherit",
  fontSize: 12,
  padding: "2px 8px",
  border,
  borderRadius: 5,
  background: "transparent",
  color: "inherit",
} as const;

type Importer =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly sources: readonly BrowserImportSourceSummary[];
      readonly sourceId: string;
      readonly handle: string;
    };

const PENDING: Record<"clearCookies" | "clearCache" | "importCookies", string> = {
  clearCookies: "Clearing cookies…",
  clearCache: "Clearing the cache…",
  importCookies: "Importing — confirm the import in the T3 Code desktop app.",
};

const firstProfile = (sources: readonly BrowserImportSourceSummary[], sourceId: string) =>
  sources.find((source) => source.id === sourceId)?.profiles[0]?.handle ?? "";

/**
 * Native's profile badge beside the address bar: names the tab's profile,
 * which is otherwise invisible, when it is not the default. The list comes
 * from the view's shared store (see `createProfileListStore`), refreshed per
 * held profile and each time the panel is shown again. A refused read shows
 * no badge (the page menu's profile group names the refusal).
 */
export function ProfileBadge(props: {
  host: Pick<ClientHost, "React" | "tooltip">;
  session: BrowserSession;
  profiles: ProfileListStore;
  visible: boolean;
}) {
  const { host, session, profiles, visible } = props;
  const profileId = sessionProfileId(session);
  const { list } = useProfileList(profiles);
  useEffect(() => {
    // Per held profile: one created after the last read would otherwise
    // read as "Removed profile" on a host without the stream.
    if (visible) profiles.refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [profiles, profileId, visible]);
  const name = profileBadgeName(list, profileId);
  if (name === null) return null;
  // Capped like native's `max-w-28`: an unbounded badge would take its width
  // from the address field, the only flexible element in the row.
  return (
    <Tooltip host={host} label={name}>
      <span
        data-t3-browser-profile-badge
        style={{
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          maxWidth: 112,
          padding: "1px 6px",
          border,
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      </span>
    </Tooltip>
  );
}

export function ProfileSection(props: {
  host?: Pick<ClientHost, "uiKit">;
  kit?: ClientUiKit | null;
  session: BrowserSession;
  api: ProfilesApi;
  profiles: ProfileListStore;
  signal: AbortSignal;
  /** Opens the current page in a new session under `profileId` (a profile is fixed at open). */
  onOpenInProfile: (profileId: string) => void;
  /** Puts an action's progress, then its named result, on the panel's status line. */
  report: (message: string) => void;
  /** Closes the menu once an action is chosen. */
  onChosen: () => void;
}) {
  const { session, api, profiles, signal, onOpenInProfile, report, onChosen } = props;
  const kit = props.kit === undefined ? resolveUiKit(props.host ?? {}) : props.kit;
  const Action = kit?.MenuItem ?? "button";
  const Heading = kit?.MenuNote ?? "span";
  const Group = kit?.MenuGroup ?? "div";
  const Note = kit?.MenuNote ?? "p";
  const profileId = sessionProfileId(session);
  const { list, error } = useProfileList(profiles);
  const listNote =
    list !== null
      ? null
      : error === null
        ? "Loading profiles…"
        : profileFailureMessage("list", error);
  const [importer, setImporter] = useState<Importer>({ kind: "closed" });

  // Opening the menu refreshes the shared list (a read on hosts without the stream).
  useEffect(() => profiles.refresh(), [profiles]);

  const name = profileLabel(list, profileId);

  const choose = (action: keyof typeof PENDING) => {
    onChosen();
    report(PENDING[action]);
  };

  const clear = (kind: "clearCookies" | "clearCache") => {
    choose(kind);
    void api.invoke(kind, { profileId }, signal).then(
      (result) => report(clearResultMessage(result, kind, name)),
      (error: unknown) => report(profileFailureMessage(kind, error)),
    );
  };

  const openImporter = () => {
    setImporter({ kind: "loading" });
    void api.invoke("listImportSources", {}, signal).then(
      ({ sources }) => {
        const usable = importableSources(sources);
        const sourceId = usable[0]?.id ?? "";
        setImporter({
          kind: "ready",
          sources: usable,
          sourceId,
          handle: firstProfile(usable, sourceId),
        });
      },
      (error: unknown) =>
        setImporter({ kind: "failed", message: profileFailureMessage("listImportSources", error) }),
    );
  };

  const runImport = (sourceId: string, handle: string) => {
    choose("importCookies");
    void api.invoke("importCookies", { profileId, sourceId, sourceProfile: handle }, signal).then(
      (result) => report(importResultMessage(result, name)),
      (error: unknown) => report(profileFailureMessage("importCookies", error)),
    );
  };

  const others = list?.profiles.filter((profile) => profile.id !== profileId) ?? [];
  const selectedSource =
    importer.kind === "ready"
      ? importer.sources.find((source) => source.id === importer.sourceId)
      : undefined;

  return (
    <Group
      role="group"
      aria-label="Profile"
      style={kit ? undefined : { display: "grid", gap: 6, borderTop: border, paddingTop: 8 }}
    >
      <Heading
        title={`Profile: ${name}`}
        style={
          kit
            ? {
                display: "block",
                maxWidth: 256,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }
            : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: muted }
        }
      >
        Profile: {name}
      </Heading>
      {listNote && (
        <Note role="note" style={kit ? undefined : { margin: 0, color: muted }}>
          {listNote}
        </Note>
      )}
      {others.length > 0 && kit ? (
        <kit.MenuRadioGroup
          value=""
          onValueChange={(profileId) => {
            onChosen();
            onOpenInProfile(profileId);
          }}
        >
          <kit.MenuGroupLabel>Open page in</kit.MenuGroupLabel>
          {others.map((profile) => (
            <kit.MenuRadioItem key={profile.id} value={profile.id}>
              {profile.name}
            </kit.MenuRadioItem>
          ))}
        </kit.MenuRadioGroup>
      ) : (
        others.length > 0 && (
          <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>Open page in</span>
            <select
              data-t3-browser-fallback-control
              aria-label="Open page in profile"
              value=""
              onChange={(event) => {
                if (!event.target.value) return;
                onChosen();
                onOpenInProfile(event.target.value);
              }}
              style={{ ...control, maxWidth: 140 }}
            >
              <option value="">Choose…</option>
              {others.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        )
      )}
      <Action
        {...(!kit ? { type: "button" as const, "data-t3-browser-fallback-control": "" } : {})}
        role="menuitem"
        onClick={() => clear("clearCookies")}
        style={kit ? undefined : { ...control, textAlign: "left" }}
      >
        Clear cookies
      </Action>
      <Action
        {...(!kit ? { type: "button" as const, "data-t3-browser-fallback-control": "" } : {})}
        role="menuitem"
        onClick={() => clear("clearCache")}
        style={kit ? undefined : { ...control, textAlign: "left" }}
      >
        Clear cache
      </Action>
      {importer.kind === "closed" ? (
        <Action
          {...(!kit ? { type: "button" as const, "data-t3-browser-fallback-control": "" } : {})}
          {...(kit ? { closeOnClick: false } : {})}
          role="menuitem"
          onClick={openImporter}
          style={kit ? undefined : { ...control, textAlign: "left" }}
        >
          Import cookies…
        </Action>
      ) : importer.kind === "loading" ? (
        <Note role="note" style={kit ? undefined : { margin: 0, color: muted }}>
          Listing browsers on the desktop…
        </Note>
      ) : importer.kind === "failed" ? (
        <Note role="note" style={kit ? undefined : { margin: 0, color: muted }}>
          {importer.message}
        </Note>
      ) : importer.sources.length === 0 ? (
        <Note role="note" style={kit ? undefined : { margin: 0, color: muted }}>
          No browser on the desktop can be imported from.
        </Note>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {kit ? (
            <kit.MenuRadioGroup
              value={importer.sourceId}
              onValueChange={(sourceId) =>
                setImporter({
                  ...importer,
                  sourceId,
                  handle: firstProfile(importer.sources, sourceId),
                })
              }
            >
              <kit.MenuGroupLabel>Import from browser</kit.MenuGroupLabel>
              {importer.sources.map((source) => (
                <kit.MenuRadioItem key={source.id} value={source.id} closeOnClick={false}>
                  {source.name}
                </kit.MenuRadioItem>
              ))}
            </kit.MenuRadioGroup>
          ) : (
            <select
              data-t3-browser-fallback-control
              aria-label="Import from browser"
              value={importer.sourceId}
              onChange={(event) =>
                setImporter({
                  ...importer,
                  sourceId: event.target.value,
                  handle: firstProfile(importer.sources, event.target.value),
                })
              }
              style={control}
            >
              {importer.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          )}
          {selectedSource?.unavailable ? (
            <Note role="note" style={kit ? undefined : { margin: 0, color: muted }}>
              {importResultMessage(
                { outcome: "failed", profileId, reason: selectedSource.unavailable },
                name,
              )}
            </Note>
          ) : kit ? (
            <kit.MenuRadioGroup
              value={importer.handle}
              onValueChange={(handle) => setImporter({ ...importer, handle })}
            >
              <kit.MenuGroupLabel>Import from browser profile</kit.MenuGroupLabel>
              {selectedSource?.profiles.map((profile) => (
                <kit.MenuRadioItem key={profile.handle} value={profile.handle} closeOnClick={false}>
                  {profile.cookieCount === undefined
                    ? profile.name
                    : `${profile.name} (${profile.cookieCount} cookies)`}
                </kit.MenuRadioItem>
              ))}
            </kit.MenuRadioGroup>
          ) : (
            <select
              data-t3-browser-fallback-control
              aria-label="Import from browser profile"
              value={importer.handle}
              onChange={(event) => setImporter({ ...importer, handle: event.target.value })}
              style={control}
            >
              {selectedSource?.profiles.map((profile) => (
                <option key={profile.handle} value={profile.handle}>
                  {profile.cookieCount === undefined
                    ? profile.name
                    : `${profile.name} (${profile.cookieCount} cookies)`}
                </option>
              ))}
            </select>
          )}
          <Action
            {...(!kit ? { type: "button" as const, "data-t3-browser-fallback-control": "" } : {})}
            role="menuitem"
            disabled={!importer.handle || selectedSource?.unavailable !== undefined}
            onClick={() => runImport(importer.sourceId, importer.handle)}
            style={kit ? undefined : { ...control, textAlign: "left" }}
          >
            Import into {name}
          </Action>
        </div>
      )}
    </Group>
  );
}
