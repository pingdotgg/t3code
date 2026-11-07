import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LanGatewayPeerSummary } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { lanGatewayEnvironment } from "~/state/lanGateway";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const failureToast = (title: string, description: string) =>
  toastManager.add(stackedThreadToast({ type: "error", title, description }));

export function LanGatewaySettings({
  environmentId,
  environmentLabel,
  isSearchTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
  readonly isSearchTarget: boolean;
}) {
  const peers = useEnvironmentQuery(lanGatewayEnvironment.list({ environmentId, input: {} }));
  const canAdd = useAtomValue(lanGatewayEnvironment.add.permissionAtom(environmentId));
  const search = searchableSetting("lan-gateway-peers");
  return (
    <SettingsSection
      {...(isSearchTarget ? { id: search.id } : {})}
      title={environmentLabel === null ? search.title : `${search.title} · ${environmentLabel}`}
      headerAction={canAdd ? <AddPeerAction environmentId={environmentId} /> : null}
    >
      {peers.error ? (
        <SettingsRow title="Could not load LAN gateway peers" description={peers.error} />
      ) : !peers.data ? (
        <SettingsRow title="Loading LAN gateway peers…" role="status" />
      ) : peers.data.peers.length === 0 ? (
        <SettingsRow
          title="No gateway peers"
          description="Add a peer by its LAN or Tailscale URL. Pair that peer on the LAN once from this client; the gateway route appears while this host is reachable."
        />
      ) : (
        peers.data.peers.map((peer) => (
          <LanGatewayPeerRow key={peer.environmentId} environmentId={environmentId} peer={peer} />
        ))
      )}
    </SettingsSection>
  );
}

function LanGatewayPeerRow({
  environmentId,
  peer,
}: {
  readonly environmentId: EnvironmentId;
  readonly peer: LanGatewayPeerSummary;
}) {
  const remove = useAtomCommand(lanGatewayEnvironment.remove, { label: "remove gateway peer" });
  const canRemove = useAtomValue(lanGatewayEnvironment.remove.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const forget = async () => {
    const confirmed = await (requestConfirmDialog(
      `Remove ${peer.label} from the LAN gateway? Clients stop reaching it through this host.`,
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    const result = await remove({
      environmentId,
      input: { environmentId: peer.environmentId },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failureToast("Could not remove the peer", String(squashAtomCommandFailure(result)));
    }
  };
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{peer.label}</h3>
          <p className="truncate text-xs text-muted-foreground">{peer.httpBaseUrl}</p>
        </div>
        {canRemove ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void forget()}
            >
              {busy ? "Removing…" : "Remove"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AddPeerAction({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const dialogSession = useRef(0);
  const formId = useId();
  const add = useAtomCommand(lanGatewayEnvironment.add, { label: "add gateway peer" });
  const ready = url.trim().length > 0;
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      dialogSession.current += 1;
      setUrl("");
      setBusy(false);
      inFlight.current = false;
    }
  };
  const submit = async () => {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const session = dialogSession.current;
    const result = await add({ environmentId, input: { url: url.trim() } });
    if (session !== dialogSession.current) return;
    inFlight.current = false;
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        failureToast("Could not add the peer", String(squashAtomCommandFailure(result)));
      }
      return;
    }
    handleOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button size="xs" variant="outline">
            <PlusIcon className="size-3.5" />
            Add peer
          </Button>
        }
      />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add LAN gateway peer</DialogTitle>
          <DialogDescription>
            Enter the peer&apos;s private, loopback, or Tailscale base URL. Pair that peer on the
            LAN once from this client so its credential is saved; the gateway route then appears
            while this host is reachable.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://192.168.1.20:13773"
              autoFocus
              aria-label="Peer URL"
            />
          </form>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost">Cancel</Button>} />
          <Button type="submit" form={formId} disabled={!ready || busy}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
