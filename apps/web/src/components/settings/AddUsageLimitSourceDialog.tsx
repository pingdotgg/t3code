import {
  type EnvironmentId,
  type SecretReference,
  type UnifiedSettings,
  UsageLimitSourceId,
} from "@lathe/contracts";
import { T, useGT } from "gt-react";
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
import { SecretInput } from "./SecretInput";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Label } from "../ui/label";

type SourceKind = "cliproxy" | "modelproxy";

/** Send the secret once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  sources,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
}) {
  const gt = useGT();
  const formId = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<SourceKind>("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const [secret, setSecret] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const trimmedUrl = url.trim();
  const canSave =
    trimmedUrl.length > 0 &&
    (kind === "cliproxy"
      ? keyValid && managementKey !== ""
      : secret.trim().length > 0 && issuer.trim().length > 0 && clientId.trim().length > 0);

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
    setSecret("");
    setIssuer("");
    setClientId("");
  };

  const save = () => {
    if (!canSave) return;
    const hubId = sourceIdFromUrl(trimmedUrl, sources);
    // Fork: a gateway takes its own prefix; a saved URL keeps the ID it already has.
    const id =
      kind === "cliproxy"
        ? hubId
        : UsageLimitSourceId.make(hubId.replace(/^cliproxy-/, "modelproxy-"));
    const common = {
      ...(label.trim() ? { label: label.trim() } : {}),
      url: trimmedUrl,
      enabled: true,
    };
    // The patch names only this entry; the server merges it into its map.
    updateSettings({
      usageLimitSources: {
        [id]:
          kind === "cliproxy"
            ? { kind, ...common, managementKey }
            : {
                kind,
                ...common,
                issuer: issuer.trim(),
                clientId: clientId.trim(),
                clientSecret: secret.trim(),
              },
      },
    });
    reset();
    onOpenChange(false);
  };

  const kindTitle: Record<SourceKind, string> = {
    cliproxy: gt("CLIProxyAPI hub"),
    modelproxy: gt("modelproxy gateway"),
  };
  const copy =
    kind === "cliproxy"
      ? {
          title: gt("Add a CLIProxyAPI hub"),
          description: gt(
            "Show the quota of every account the hub pools. The management key stays on {environment}.",
            { environment: environmentLabel },
          ),
          action: gt("Add hub"),
        }
      : {
          title: gt("Add a modelproxy gateway"),
          description: gt(
            "Show which account the gateway is serving and how much headroom the pool has. You sign in as yourself; the client secret and your session stay on {environment}.",
            { environment: environmentLabel },
          ),
          action: gt("Add gateway"),
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
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
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
              <div className="flex gap-1" role="radiogroup" aria-label={gt("Source kind")}>
                {(["cliproxy", "modelproxy"] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    size="xs"
                    role="radio"
                    aria-checked={kind === option}
                    variant={kind === option ? "default" : "outline"}
                    onClick={() => setKind(option)}
                  >
                    {kindTitle[option]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">
                {kind === "cliproxy" ? <T>Hub URL</T> : <T>Gateway URL</T>}
              </Label>
              <Input
                id="usage-source-url"
                placeholder={
                  kind === "cliproxy"
                    ? "https://hub.example.ts.net:8318"
                    : "https://iris.example.com"
                }
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            {kind === "modelproxy" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-issuer">
                    <T>OIDC issuer</T>
                  </Label>
                  <Input
                    id="usage-source-issuer"
                    placeholder="https://auth.example.com/realms/main"
                    value={issuer}
                    onChange={(event) => setIssuer(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-client-id">
                    <T>Client ID</T>
                  </Label>
                  <Input
                    id="usage-source-client-id"
                    placeholder="lathe"
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                  />
                </div>
              </>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">
                {kind === "cliproxy" ? <T>Management key</T> : <T>Client secret</T>}
              </Label>
              {kind === "cliproxy" ? (
                <SecretSourceInput
                  id="usage-source-key"
                  aria-label={gt("Management key")}
                  value={keyDraft}
                  sources={secretSources}
                  environmentId={environmentId}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  onSecretChange={(reference) => setKeyDraft(reference ?? "")}
                  onValidityChange={setKeyValid}
                />
              ) : (
                <SecretInput
                  id="usage-source-key"
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              )}
            </div>
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
            {copy.action}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
