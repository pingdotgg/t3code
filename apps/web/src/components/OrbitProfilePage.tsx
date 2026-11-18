import {
  newOrbitProfileName,
  ORBIT_PROFILE_PARTS,
  orbitProfileSummary,
  orbitSignedInText,
  switchOrbitProfile,
  type OrbitGatewayNode,
  type OrbitGatewayProfile,
  type OrbitProfileChoice,
} from "@t3tools/client-runtime/orbit-gateway";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import {
  desktopOrbitGatewayClient,
  orbitProfileRebinding,
  syncOrbitProfileNow,
  useOrbitProfileSyncStatus,
} from "~/orbit/OrbitProfileSync";

import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { SelectButton } from "./ui/select";
import { toastManager } from "./ui/toast";

interface ProfileView {
  readonly node: OrbitGatewayNode;
  readonly profiles: readonly OrbitGatewayProfile[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** This device's Node and the profiles, read on mount and after each profile sync. */
function useOrbitProfiles() {
  // One client per mount: the load effect below must not restart on every render.
  const [client] = useState(desktopOrbitGatewayClient);
  const syncedAt = useOrbitProfileSyncStatus((status) => status.syncedAt);
  const [view, setView] = useState<ProfileView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useStableCallback(async () => {
    if (!client) return;
    try {
      const [node, profiles] = await Promise.all([client.me(), client.profiles()]);
      setView({ node, profiles });
      setLoadError(null);
    } catch (error) {
      setLoadError(message(error));
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the Orbit Gateway on mount and after each profile sync
  useEffect(() => {
    void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A finished profile sync can change the node and profiles, so the view reloads.
  }, [load, syncedAt]);

  return { gateway: client, view, loadError, load };
}

/**
 * The Orbit panel's Profile page. A profile is one set of settings: workspaces, appearance and
 * desktop settings all follow it, and a change on this device updates it at once. Choosing
 * another profile copies its settings to this device; "New profile…" makes one from this device.
 */
export function OrbitProfilePage() {
  const { gateway, view, loadError, load } = useOrbitProfiles();
  const sync = useOrbitProfileSyncStatus();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const profile = view?.node.profile ?? null;
  const summary = orbitProfileSummary(sync, profile?.name ?? null);
  const name = newOrbitProfileName(newName);

  const choose = async (choice: OrbitProfileChoice) => {
    if (!gateway) return;
    setBusy(true);
    try {
      await switchOrbitProfile(
        { client: gateway, sync: syncOrbitProfileNow, rebinding: orbitProfileRebinding },
        choice,
      );
      setCreating(false);
      setNewName("");
      await load();
    } catch (error) {
      toastManager.add({ type: "error", title: "Orbit", description: message(error) });
    }
    // Not in `finally`: the React Compiler cannot compile a finalizer clause.
    setBusy(false);
  };
  const create = () => {
    if (name !== null && !busy) void choose({ name });
  };
  const cancel = () => {
    setCreating(false);
    setNewName("");
  };

  return (
    <SettingsPageContainer width="wide">
      {view && loadError === null ? null : (
        <SettingsSection id="orbit-device" title="Orbit Gateway" hideTitle>
          <SettingsRow
            title={view?.node.name ?? (loadError ? "Gateway unreachable" : "Connecting…")}
            description={loadError ?? (view ? orbitSignedInText(view.node) : "gateway.orbit")}
            control={
              <Button size="xs" variant="outline" onClick={() => void load()}>
                Reload
              </Button>
            }
          />
        </SettingsSection>
      )}

      {view ? (
        <SettingsSection id="orbit-profile" title="Profile" hideTitle>
          <SettingsRow
            title="Profile"
            description={
              creating
                ? "The new profile starts with what this device has now."
                : summary.description
            }
            status={creating ? undefined : (summary.problem ?? undefined)}
            control={
              creating ? (
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Profile name"
                    placeholder="Profile name"
                    autoFocus
                    spellCheck={false}
                    value={newName}
                    disabled={busy}
                    onChange={(event) => setNewName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") create();
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        cancel();
                      }
                    }}
                  />
                  <Button size="xs" variant="outline" disabled={busy} onClick={cancel}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={name === null || busy} onClick={create}>
                    Create
                  </Button>
                </div>
              ) : (
                <Menu>
                  <MenuTrigger
                    render={<SelectButton size="sm" />}
                    aria-label="Profile"
                    disabled={busy}
                  >
                    {profile?.name ?? "Choose a profile"}
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuRadioGroup
                      value={profile ? String(profile.id) : ""}
                      onValueChange={(next) => {
                        const chosen = view.profiles.find((entry) => String(entry.id) === next);
                        if (chosen && chosen.id !== profile?.id) void choose({ id: chosen.id });
                      }}
                    >
                      {view.profiles.map((entry) => (
                        <MenuRadioItem key={entry.id} value={String(entry.id)} closeOnClick>
                          <span className="flex items-center gap-2">
                            <span className="flex size-4 items-center justify-center">
                              <MenuRadioItemIndicator />
                            </span>
                            {entry.name}
                          </span>
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                    <MenuSeparator />
                    <MenuItem onClick={() => setCreating(true)}>
                      <PlusIcon />
                      New profile…
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              )
            }
          />
        </SettingsSection>
      ) : null}

      {view ? (
        <SettingsSection id="orbit-profile-parts" title="What the profile holds" hideTitle>
          {ORBIT_PROFILE_PARTS.map((part) => (
            <SettingsRow
              key={part.key}
              data-profile-part={part.key}
              title={part.label}
              description={part.description}
              control={
                summary.synced[part.key] ? (
                  <span className="flex items-center gap-1 text-ui text-muted-foreground">
                    <CheckIcon className="size-3.5" />
                    Synced
                  </span>
                ) : null
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
