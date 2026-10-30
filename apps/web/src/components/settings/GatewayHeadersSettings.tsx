import type { DesktopGatewayHeadersEntry, DesktopGatewayHeadersInput } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import {
  desktopGatewayHeadersStateAtom,
  refreshDesktopGatewayHeadersState,
} from "~/state/desktopGatewayHeaders";
import { useEnvironmentQuery } from "~/state/query";
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
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { formatDesktopBridgeError, resolveGatewayHeadersInput } from "./ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export const GATEWAY_HEADERS_PLACEHOLDER =
  "CF-Access-Client-Id: <client id>\nCF-Access-Client-Secret: <client secret>";

function GatewayHeadersDialog({
  origin,
  onClose,
}: {
  /** `""` adds headers for a new address; an origin replaces that origin's headers. */
  readonly origin: string | null;
  readonly onClose: () => void;
}) {
  const [host, setHost] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const replacing = origin !== null && origin !== "";

  const close = () => {
    setHost("");
    setHeadersText("");
    setError(null);
    onClose();
  };

  const save = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let input: DesktopGatewayHeadersInput;
    try {
      input = resolveGatewayHeadersInput({ origin: replacing ? origin : null, host, headersText });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the gateway headers.");
      return;
    }
    setSaving(true);
    try {
      await bridge.setGatewayHeaders(input);
      refreshDesktopGatewayHeadersState();
      toastManager.add({
        type: "success",
        title: "Gateway headers saved",
        description: `Requests to ${input.origin} now carry them.`,
      });
      close();
    } catch (cause) {
      setError(formatDesktopBridgeError(cause, "Could not save the gateway headers."));
    }
    setSaving(false);
  };

  return (
    <Dialog open={origin !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {replacing ? `Replace headers for ${origin}` : "Add access gateway"}
          </DialogTitle>
          <DialogDescription>
            This app adds these headers to every request it sends to the environment, so it can pass
            an access proxy such as Cloudflare Access. They stay encrypted on this device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {replacing ? null : (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Environment address
                </span>
                <Input
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="backend.example.com"
                  disabled={saving}
                  spellCheck={false}
                />
              </label>
            )}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Headers</span>
              <Textarea
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={GATEWAY_HEADERS_PLACEHOLDER}
                disabled={saving}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={close}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function GatewayHeadersRow({
  entry,
  onReplace,
}: {
  readonly entry: DesktopGatewayHeadersEntry;
  readonly onReplace: (origin: string) => void;
}) {
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const confirmed = await requestConfirmDialog(
      `Stop sending gateway headers to ${entry.origin}?\nEnvironments behind its access proxy will stop connecting.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setRemoving(true);
    try {
      await bridge.removeGatewayHeaders(entry.origin);
      refreshDesktopGatewayHeadersState();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not remove gateway headers",
        description: formatDesktopBridgeError(cause, "Try again."),
      });
    }
    setRemoving(false);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium text-foreground">{entry.origin}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {entry.headerNames.join(", ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={removing}
            onClick={() => onReplace(entry.origin)}
          >
            Replace
          </Button>
          <Button size="xs" variant="outline" disabled={removing} onClick={() => void remove()}>
            {removing ? "Removing…" : "Remove"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Desktop-only: a browser cannot add headers to a WebSocket, so the hosted and local web apps cannot offer this. */
export function GatewayHeadersSettings() {
  const gatewayHeaders = useEnvironmentQuery(desktopGatewayHeadersStateAtom);
  const [dialogOrigin, setDialogOrigin] = useState<string | null>(null);
  const entries = gatewayHeaders.data ?? [];

  return (
    <SettingsSection
      {...searchableSetting("access-gateways")}
      title="Access gateways"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={() => setDialogOrigin("")}>
          <PlusIcon className="size-3" />
          <span>Add gateway</span>
        </Button>
      }
    >
      {entries.length === 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground">
            {gatewayHeaders.error ??
              "Reach an environment behind Cloudflare Access or another access proxy by adding its service token headers."}
          </p>
        </div>
      ) : (
        entries.map((entry) => (
          <GatewayHeadersRow key={entry.origin} entry={entry} onReplace={setDialogOrigin} />
        ))
      )}
      <GatewayHeadersDialog origin={dialogOrigin} onClose={() => setDialogOrigin(null)} />
    </SettingsSection>
  );
}
