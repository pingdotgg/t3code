import type { BearerConnectionProfile } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { updateBearerConnection } from "~/connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

/** Splits a one-address-per-line field. */
function parseRouteList(value: string): ReadonlyArray<string> {
  return value.split(/\s+/u).filter((line) => line !== "");
}

/**
 * Edits a saved pairing: its name, the preferred address, and any other
 * addresses that reach the same machine. Routes are dialed together and the
 * first to answer wins unless the preferred one is pinned.
 */
export function EditSavedBackendDialog({
  profile,
  onClose,
}: {
  readonly profile: BearerConnectionProfile;
  readonly onClose: () => void;
}) {
  const [label, setLabel] = useState(profile.label);
  const [httpBaseUrl, setHttpBaseUrl] = useState(profile.httpBaseUrl);
  const [routes, setRoutes] = useState((profile.alternateHttpBaseUrls ?? []).join("\n"));
  const [pinnedRoute, setPinnedRoute] = useState(profile.pinnedRoute === true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const update = useAtomCommand(updateBearerConnection, { reportFailure: false });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const result = await update({
      environmentId: profile.environmentId,
      label,
      httpBaseUrl,
      alternateHttpBaseUrls: parseRouteList(routes),
      pinnedRoute,
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update environment.");
      }
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit environment</DialogTitle>
          <DialogDescription>
            Add every address this device can use to reach the machine, such as a LAN address and a
            tailnet address.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Label</span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Preferred URL</span>
            <Input
              value={httpBaseUrl}
              onChange={(event) => setHttpBaseUrl(event.target.value)}
              placeholder="https://machine.tailnet.ts.net"
              spellCheck={false}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Other URLs</span>
            <Textarea
              value={routes}
              onChange={(event) => setRoutes(event.target.value)}
              placeholder={"http://192.168.1.20:3773\nOne address per line"}
              rows={3}
              spellCheck={false}
              className="text-xs leading-relaxed"
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                Always use the preferred URL
              </span>
              <span className="block text-[11px] text-muted-foreground">
                Off dials every address at once and keeps the first one that answers.
              </span>
            </span>
            <Switch size="sm" checked={pinnedRoute} onCheckedChange={setPinnedRoute} />
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
