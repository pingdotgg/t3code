import { type EnvironmentId, UsageLimitSourceId } from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
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
import { Label } from "../ui/label";

export type UsageLimitSourceKind = "cliproxy" | "openrouter";

/**
 * Stable per hub and readable in settings.json. Dots and dashes in the host
 * are kept so `foo-bar.com` and `foo.bar.com` do not collide; anything else
 * (a port's colon, a path) is folded to a dash.
 */
function sourceIdFromUrl(url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw text; the server reports the bad URL on its row.
  }
  return UsageLimitSourceId.make(`cliproxy-${slug(host) || "hub"}`);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * An OpenRouter account has no URL to key an id off, so the label does it. A
 * second unlabelled account would collide with the first, which is the honest
 * outcome: one key per id, edited in place.
 */
function openRouterSourceId(label: string): UsageLimitSourceId {
  const suffix = slug(label);
  return UsageLimitSourceId.make(suffix ? `openrouter-${suffix}` : "openrouter");
}

/**
 * Adds a usage limit source from provider settings on one environment. The key
 * is sent once and kept in that server's secret store; settings only ever carry
 * a redaction marker for it afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  kind,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind: UsageLimitSourceKind;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const isOpenRouter = kind === "openrouter";
  const trimmedUrl = url.trim();
  const canSave = managementKey.trim().length > 0 && (isOpenRouter || trimmedUrl.length > 0);

  const reset = () => {
    setLabel("");
    setUrl("");
    setManagementKey("");
  };

  const save = () => {
    if (!canSave) return;
    const trimmedLabel = label.trim();
    const entry = isOpenRouter
      ? {
          kind: "openrouter" as const,
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          managementKey: managementKey.trim(),
          enabled: true,
        }
      : {
          kind: "cliproxy" as const,
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          url: trimmedUrl,
          managementKey: managementKey.trim(),
          enabled: true,
        };
    // The patch names only this entry; the server merges it into its map.
    updateSettings({
      usageLimitSources: {
        [isOpenRouter ? openRouterSourceId(trimmedLabel) : sourceIdFromUrl(trimmedUrl)]: entry,
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isOpenRouter ? "Add OpenRouter" : "Add a CLIProxyAPI hub"}</DialogTitle>
          <DialogDescription>
            {isOpenRouter
              ? `Show your OpenRouter credit balance under Usage → Limits on ${environmentLabel}. The key stays on that server.`
              : `Show the quota of every account the hub pools, next to the providers on ${environmentLabel}. The key stays on that server.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {isOpenRouter ? null : (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-url">Hub URL</Label>
                <Input
                  id="usage-source-url"
                  placeholder="https://hub.example.ts.net:8318"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  autoFocus
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">
                {isOpenRouter ? "API key" : "Management key"}
              </Label>
              <Input
                id="usage-source-key"
                type="password"
                autoComplete="off"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
                autoFocus={isOpenRouter}
              />
              {isOpenRouter ? (
                <p className="text-xs text-muted-foreground">
                  A provisioning key reports the account balance. An ordinary API key still works,
                  but only reports that key's own spend and limit.
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder={
                  isOpenRouter ? "Defaults to OpenRouter" : "Defaults to the hub's host name"
                }
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {isOpenRouter ? "Add OpenRouter" : "Add hub"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
