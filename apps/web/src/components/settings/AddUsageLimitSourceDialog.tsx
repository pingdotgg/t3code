import { msg } from "gt-react";
import { m } from "../../i18n/messages";
import type {
  EnvironmentId,
  SecretReference,
  UnifiedSettings,
  UsageLimitSourceKind,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

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
import { sourceIdFromUrl } from "./AddUsageLimitSourceDialog.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const KINDS: ReadonlyArray<{
  readonly kind: UsageLimitSourceKind;
  readonly label: string;
  readonly urlLabel: string;
  readonly urlPlaceholder: string;
  readonly needsKey: boolean;
  readonly description: string;
}> = [
  {
    kind: "cliproxy",
    label: m(msg("CLIProxyAPI hub")),
    urlLabel: m(msg("Hub URL")),
    urlPlaceholder: "https://hub.example.ts.net:8318",
    needsKey: true,
    description: m(msg("Every account the hub pools, read through its management API.")),
  },
  {
    kind: "http",
    label: m(msg("HTTP quota source")),
    urlLabel: m(msg("Endpoint URL")),
    urlPlaceholder: "https://quota.example.com/limits",
    needsKey: false,
    description: m(msg("Quota from an HTTP endpoint.")),
  },
  {
    kind: "aiusage",
    label: m(msg("Usage dashboard")),
    urlLabel: m(msg("Dashboard URL")),
    urlPlaceholder: "http://127.0.0.1:8787",
    needsKey: false,
    // It holds the credentials itself and answers on loopback, so there is
    // nothing for PseudoCode to authenticate with.
    description: m(
      msg(
        "Every subscription the dashboard polls, including accounts nothing here is signed into.",
      ),
    ),
  },
];

/** Send the management key once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
  kind: initialKind = "cliproxy",
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: UsageLimitSourceKind;
  readonly sources: UnifiedSettings["usageLimitSources"];
}) {
  const gt = useGT();
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<UsageLimitSourceKind>(initialKind);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const spec = KINDS.find((entry) => entry.kind === kind) ?? KINDS[0]!;
  const trimmedUrl = url.trim();
  const http = kind === "http";
  const endpoint = URL.parse(trimmedUrl);
  const canSave = http
    ? keyValid &&
      endpoint !== null &&
      /^https?:$/.test(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password
    : trimmedUrl.length > 0 && (!spec.needsKey || (keyValid && managementKey !== ""));

  const reset = () => {
    setKind(initialKind);
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(kind, trimmedUrl, sources);
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() ? { label: label.trim() } : {}),
          url: trimmedUrl,
          managementKey: spec.needsKey || http ? managementKey : "",
          enabled: true,
        },
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
          <DialogTitle>
            <T>Add a usage source</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Show quota alongside the providers on <Var>{environmentLabel}</Var>. The key stays on
              that server.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label>
                <T>Kind</T>
              </Label>
              <ToggleGroup
                value={[kind]}
                onValueChange={(next) => {
                  const picked = next[0];
                  if (picked !== undefined) setKind(picked as UsageLimitSourceKind);
                }}
              >
                {KINDS.map((entry) => (
                  <Toggle key={entry.kind} value={entry.kind} className="flex-1">
                    {entry.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <span className="text-xs text-muted-foreground">{spec.description}</span>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">{spec.urlLabel}</Label>
              <Input
                id="usage-source-url"
                placeholder={spec.urlPlaceholder}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            {spec.needsKey || http ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-key">
                  {http ? <T>Bearer token (optional)</T> : <T>Management key</T>}
                </Label>
                <SecretSourceInput
                  id="usage-source-key"
                  aria-label={http ? gt("Bearer token (optional)") : gt("Management key")}
                  value={keyDraft}
                  sources={secretSources}
                  environmentId={environmentId}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                  onValidityChange={setKeyValid}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">
                <T>Label (optional)</T>
              </Label>
              <Input
                id="usage-source-label"
                placeholder={gt("Defaults to the host name")}
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
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            <T>Add source</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
