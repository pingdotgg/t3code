import {
  createSecretDeliveryReveal,
  SECRET_DELIVERY_PRIVACY_NOTE,
  secretDeliveryDisplay,
  secretDeliveryInput,
  type SecretDeliveryItem,
  type SecretDeliveryUnavailableReason,
} from "@t3tools/client-runtime/secret-delivery";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useDeadlinePassed } from "../../hooks/useDeadline";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { WorkLogRow } from "./WorkLog";

/**
 * A secret an agent delivered. The value lives only in this card's reveal state:
 * never in queries, drafts, logs or the thread, and it is dropped on Hide, Delete,
 * leaving the thread, unmount and the tab going to the background.
 */
export function SecretDeliveryCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretDeliveryItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  /** False in guest views and read-only connections. */
  readonly canOperateThread: boolean;
}) {
  const { item } = props;
  const deadlinePassed = useDeadlinePassed(item.expiresAt);
  const display = secretDeliveryDisplay(item, {
    visibility: props.visibility,
    deadlinePassed,
    canRetrieve: props.canOperateThread,
  });
  if (display.kind === "unavailable") {
    return <SecretDeliveryRow item={item} label={display.label} reason={display.reason} />;
  }
  return (
    <AvailableSecretDelivery
      key={`${props.environmentId}:${item.id}`}
      environmentId={props.environmentId}
      item={item}
    />
  );
}

function SecretDeliveryRow(props: {
  readonly item: SecretDeliveryItem;
  readonly label: string;
  readonly reason: SecretDeliveryUnavailableReason;
}) {
  const Icon = props.reason === "deleted" || props.reason === "expired" ? MinusIcon : LockIcon;
  return (
    <WorkLogRow
      data-v2-item-type={props.item.type}
      icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
      label={
        <>
          {props.item.label} · {props.label}
        </>
      }
    />
  );
}

/** Chromium and Safari accept a pending value, so the write keeps the click's user activation. */
async function writeSecretToClipboard(value: Promise<string>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write !== undefined) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": value.then((text) => new Blob([text], { type: "text/plain" })),
        }),
      ]);
      return true;
    } catch {
      // Fall through: some browsers reject a pending clipboard item but take plain text.
    }
  }
  return writeTextToClipboard(await value, "secret");
}

function AvailableSecretDelivery(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretDeliveryItem;
}) {
  const { item } = props;
  const commandOptions = { reportFailure: false, reportDefect: false } as const;
  // The read's success holds the value and its failure may echo it; keep both out of the console.
  const read = useAtomCommand(serverEnvironment.readSecretDelivery, {
    label: "read secret delivery",
    ...commandOptions,
  });
  const remove = useAtomCommand(serverEnvironment.deleteSecretDelivery, {
    label: "delete secret delivery",
    ...commandOptions,
  });
  const canRetrieve = useAtomValue(
    serverEnvironment.readSecretDelivery.permissionAtom(props.environmentId),
  );
  const canDelete = useAtomValue(
    serverEnvironment.deleteSecretDelivery.permissionAtom(props.environmentId),
  );
  const [reveal] = useState(() =>
    createSecretDeliveryReveal({
      read: () => read({ environmentId: props.environmentId, input: secretDeliveryInput(item) }),
      delete: () =>
        remove({ environmentId: props.environmentId, input: secretDeliveryInput(item) }),
    }),
  );
  const state = useSyncExternalStore(reveal.subscribe, reveal.getState, reveal.getState);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops the value when the tab is hidden and when the card unmounts
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") reveal.hide();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reveal.hide();
    };
  }, [reveal]);

  if (state.deleted) return <SecretDeliveryRow item={item} label="Deleted" reason="deleted" />;

  const busy = state.pending !== null;
  const confirmDelete = async () => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Delete "${item.label}"?\nT3 removes its copy. Anything already copied stays where it is.`,
      { variant: "destructive" },
    );
    if (confirmed) void reveal.delete();
  };

  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground">{item.label}</p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canRetrieve || busy}
            onClick={() => (state.value === null ? void reveal.reveal() : reveal.hide())}
          >
            {state.value === null ? "Reveal" : "Hide"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canRetrieve || busy}
            onClick={() => void reveal.copy(writeSecretToClipboard)}
          >
            {state.copied ? <CheckIcon aria-hidden /> : null}
            {state.copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
      {state.value === null ? (
        <p className="font-mono text-sm text-muted-foreground">
          <span aria-hidden>••••••••••••</span>
          <span className="sr-only">Hidden</span>
        </p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg border border-border/60 bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-foreground">
          {state.value}
        </pre>
      )}
      {state.error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {SECRET_DELIVERY_PRIVACY_NOTE}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={!canDelete || busy}
          onClick={() => void confirmDelete()}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
