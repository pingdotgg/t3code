import { PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { EnvironmentId, OutboundConnectionView } from "@t3tools/contracts";

import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { toastManager, stackedThreadToast } from "~/components/ui/toast";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useWorkflowApi } from "~/workflow/useWorkflowApi";

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

// ─── connection row ───────────────────────────────────────────────────────────

function ConnectionRow({
  connection,
  isDeleting,
  onDelete,
}: {
  readonly connection: OutboundConnectionView;
  readonly isDeleting: boolean;
  readonly onDelete: (connectionRef: string) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium text-foreground">{connection.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {connection.kind} · ref: {connection.connectionRef}
          </p>
        </div>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={isDeleting}
            onClick={() => setConfirmOpen(true)}
          >
            {isDeleting ? (
              <>
                <Spinner className="size-3" />
                Removing…
              </>
            ) : (
              <>
                <Trash2Icon className="size-3.5" />
                Remove
              </>
            )}
          </Button>
          <AlertDialogPopup className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove connection?</AlertDialogTitle>
              <AlertDialogDescription>
                Boards using &ldquo;{connection.displayName}&rdquo; will stop sending outbound
                events. Existing sent events are unaffected.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false);
                  onDelete(connection.connectionRef);
                }}
              >
                Remove connection
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    </div>
  );
}

// ─── add-connection dialog ────────────────────────────────────────────────────

function AddConnectionDialog({
  onAdd,
}: {
  readonly onAdd: (input: {
    kind: "webhook" | "slack";
    displayName: string;
    url: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"webhook" | "slack">("webhook");
  const [displayName, setDisplayName] = useState("");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const reset = () => {
    setKind("webhook");
    setDisplayName("");
    setUrl("");
    setSubmitError(null);
  };

  const handleSubmit = async () => {
    if (!displayName.trim() || !url.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onAdd({ kind, displayName: displayName.trim(), url: url.trim() });
      reset();
      setOpen(false);
    } catch (error: unknown) {
      setSubmitError(error instanceof Error ? error.message : "An unknown error occurred.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs" variant="default">
            <PlusIcon className="size-3" />
            Add connection
          </Button>
        }
      />
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add outbound connection</DialogTitle>
          <DialogDescription>
            Enter the destination URL for outbound events. The URL is stored server-side and never
            displayed again after saving.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Kind</span>
            <select
              className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
              value={kind}
              disabled={submitting}
              onChange={(e) => setKind(e.currentTarget.value as "webhook" | "slack")}
            >
              <option value="webhook">Webhook</option>
              <option value="slack">Slack</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Display name</span>
            <Input
              value={displayName}
              disabled={submitting}
              placeholder={kind === "webhook" ? "My webhook" : "My Slack channel"}
              autoFocus
              onChange={(e) => setDisplayName(e.currentTarget.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              {kind === "webhook" ? "Webhook URL" : "Slack incoming webhook URL"}
            </span>
            <Input
              type="url"
              value={url}
              disabled={submitting}
              placeholder={
                kind === "webhook" ? "https://example.com/hook" : "https://hooks.slack.com/…"
              }
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {kind === "webhook"
                ? "Must be an https:// URL. Private/internal addresses are rejected."
                : "Use an Incoming Webhook URL from your Slack app configuration."}
            </p>
          </label>
          {submitError !== null && <p className="text-sm text-destructive">{submitError}</p>}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={submitting || !displayName.trim() || !url.trim()}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Adding…" : "Add connection"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ─── inner panel (environmentId is guaranteed non-null here) ─────────────────

function OutboundConnectionsPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const workflowApi = useWorkflowApi(environmentId);

  const [connections, setConnections] = useState<ReadonlyArray<OutboundConnectionView> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingRef, setDeletingRef] = useState<string | null>(null);

  const loadConnections = useCallback(() => {
    setLoadError(null);
    workflowApi
      .listOutboundConnections({})
      .then((result) => setConnections(result.connections))
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Failed to load connections.");
      });
  }, [workflowApi]);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const handleAdd = useCallback(
    async (input: { kind: "webhook" | "slack"; displayName: string; url: string }) => {
      const { connection } = await workflowApi.createOutboundConnection(input);
      setConnections((current) => (current ? [...current, connection] : [connection]));
      toastManager.add({ type: "success", title: "Connection added" });
    },
    [workflowApi],
  );

  const handleDelete = useCallback(
    (connectionRef: string) => {
      setDeletingRef(connectionRef);
      workflowApi
        .deleteOutboundConnection({ connectionRef })
        .then(() => {
          setConnections((current) =>
            current ? current.filter((c) => c.connectionRef !== connectionRef) : current,
          );
          toastManager.add({ type: "success", title: "Connection removed" });
        })
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not remove connection",
              description: error instanceof Error ? error.message : "An unknown error occurred.",
            }),
          );
        })
        .finally(() => setDeletingRef(null));
    },
    [workflowApi],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Outbound Connections"
        headerAction={<AddConnectionDialog onAdd={handleAdd} />}
      >
        {loadError ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-destructive">{loadError}</p>
          </div>
        ) : connections === null ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading…
            </p>
          </div>
        ) : connections.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-muted-foreground">
              No outbound connections yet. Add one to start sending board events to webhooks or
              Slack.
            </p>
          </div>
        ) : (
          connections.map((connection) => (
            <ConnectionRow
              key={connection.connectionRef}
              connection={connection}
              isDeleting={deletingRef === connection.connectionRef}
              onDelete={handleDelete}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// ─── main settings component ─────────────────────────────────────────────────

export function OutboundConnectionsSettings() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  if (!primaryEnvironmentId) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Outbound Connections">
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-sm text-muted-foreground">No environment connected.</p>
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return <OutboundConnectionsPanel environmentId={primaryEnvironmentId} />;
}
