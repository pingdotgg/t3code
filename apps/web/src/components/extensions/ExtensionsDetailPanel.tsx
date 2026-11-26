// Fork: Kaluwa's Extensions page. One extension across every subscription.
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CopyIcon, LockIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { ExtensionActions, ExtensionAddHereButton } from "./ExtensionActions";
import { useExtensions } from "./extensionsContext";
import {
  type ExtensionEntry,
  copyMutation,
  entryDiffers,
  entryMissingIn,
  needsAttention,
  presenceHealth,
  supportsKind,
} from "./extensionsModel";
import {
  EditButton,
  EntryTags,
  HealthStatus,
  KindIcon,
  SubscriptionIcon,
  useKindLabels,
} from "./extensionsParts";

function SubscriptionState({
  entry,
  subscription,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
}) {
  const gt = useGT();
  const presence = entry.presence.get(subscription.instanceId);
  const health = presence ? presenceHealth(presence) : null;
  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-32 flex-1 items-center gap-2.5">
          <SubscriptionIcon subscription={subscription} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{subscription.displayName}</span>
            {presence ? (
              <HealthStatus entry={entry} presence={presence} />
            ) : (
              <span className="text-xs text-muted-foreground">
                {supportsKind(subscription, entry.kind)
                  ? gt("Not added")
                  : gt("Not available for this subscription")}
              </span>
            )}
          </span>
        </span>
        {presence ? (
          <ExtensionActions entry={entry} subscription={subscription} />
        ) : supportsKind(subscription, entry.kind) ? (
          <ExtensionAddHereButton entry={entry} subscription={subscription} />
        ) : null}
      </div>
      {presence && health !== null && needsAttention(health) ? (
        <p
          className={cn(
            "wrap-anywhere rounded-md border px-2.5 py-2 text-xs",
            health === "failing"
              ? "border-destructive/32 bg-destructive/8 font-mono text-destructive-foreground"
              : "border-warning/32 bg-warning-surface text-warning-foreground",
          )}
        >
          {presence.detail ??
            (health === "failing"
              ? gt("It could not be reached.")
              : gt("Not signed in on this subscription yet."))}
        </p>
      ) : null}
      {presence?.managedElsewhere ? (
        <p className="text-xs text-muted-foreground">
          <T>An account-level connector. Change it on the provider's website.</T>
        </p>
      ) : null}
      {presence && presence.secretNames.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {presence.secretNames.map((name) => (
            <li key={name} className="flex items-center gap-2 text-xs text-muted-foreground">
              <LockIcon aria-hidden className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
              <span>
                <T>Set</T>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function ExtensionsDetailPanel({
  entry,
  container,
  onClose,
}: {
  readonly entry: ExtensionEntry | null;
  readonly container: HTMLElement | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const kinds = useKindLabels();
  const { list, run, isPending } = useExtensions();
  if (entry === null || container === null) return null;
  const missing = entryMissingIn(entry, list.subscriptions);
  const copyAll = copyMutation(
    entry,
    missing.map((subscription) => subscription.instanceId),
  );
  const present = list.subscriptions.filter((subscription) =>
    entry.presence.has(subscription.instanceId),
  );

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal container={container}>
        <DialogPrimitive.Backdrop className="absolute inset-0 z-20 bg-background/50" />
        <DialogPrimitive.Popup
          aria-label={gt("{name} details", { name: entry.name })}
          className="absolute inset-y-0 end-0 z-20 flex w-full max-w-md flex-col border-s bg-popover text-popover-foreground shadow-xl outline-none"
        >
          <header className="flex items-start gap-3 border-b px-4 py-3">
            <KindIcon entry={entry} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <DialogPrimitive.Title className="min-w-0 truncate text-base font-semibold">
                  {entry.name}
                </DialogPrimitive.Title>
                <EntryTags entry={entry} />
              </span>
              <span className="wrap-anywhere text-xs text-muted-foreground">
                {[kinds.singular(entry.kind), entry.marketplace, entry.description]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
            <DialogPrimitive.Close
              aria-label={gt("Close", { $context: "button, closes the panel" })}
              render={<Button size="icon-sm" variant="ghost" />}
            >
              <XIcon />
            </DialogPrimitive.Close>
          </header>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              {entryDiffers(entry) ? (
                <div className="flex flex-col gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2.5">
                  <p className="text-sm font-medium">
                    {entry.kind === "mcp"
                      ? gt("The command or URL differs between subscriptions")
                      : entry.kind === "plugin"
                        ? gt("The version differs between subscriptions")
                        : gt("Subscriptions have separate copies")}
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {present.map((subscription) => (
                      <li key={subscription.instanceId} className="flex items-center gap-2">
                        <SubscriptionIcon subscription={subscription} size="compact" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">
                          {entry.presence.get(subscription.instanceId)?.location}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : entry.target ? (
                <p className="wrap-anywhere rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs">
                  {entry.target}
                </p>
              ) : null}

              <section className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    <T>Subscriptions</T>
                  </h3>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {gt("In {present} of {total}", {
                      present: present.length,
                      total: list.subscriptions.length,
                    })}
                  </span>
                </div>
                <ul className="divide-y rounded-lg border">
                  {list.subscriptions.map((subscription) => (
                    <SubscriptionState
                      key={subscription.instanceId}
                      entry={entry}
                      subscription={subscription}
                    />
                  ))}
                </ul>
                {copyAll !== null && missing.length > 1 ? (
                  <span>
                    <EditButton
                      size="sm"
                      variant="outline"
                      busy={missing.some((subscription) =>
                        isPending(subscription.instanceId, entry.key),
                      )}
                      onClick={() => void run([copyAll])}
                    >
                      <CopyIcon />
                      {gt("Add to all {count} missing", { count: missing.length })}
                    </EditButton>
                  </span>
                ) : null}
              </section>
            </div>
          </ScrollArea>
          <footer className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            <T>User-level. Projects can add their own on top.</T>
          </footer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
