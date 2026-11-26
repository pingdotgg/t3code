// Fork: Kaluwa's Extensions page. One subscription: what needs attention, then each kind.
import type { ExtensionKind, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ChevronRightIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { ExtensionActions, ExtensionAddHereButton } from "./ExtensionActions";
import { useExtensions } from "./extensionsContext";
import {
  EXTENSION_KINDS,
  type ExtensionAttentionItem,
  type ExtensionEntry,
  compareHealth,
  entryCanCopy,
  entryMatchesSearch,
  needsAttention,
  presenceHealth,
  subscriptionAttention,
  supportsKind,
} from "./extensionsModel";
import {
  AllClear,
  EntryTitle,
  HealthGlyph,
  HealthStatus,
  KindIcon,
  SectionCard,
  SubscriptionIcon,
  useKindLabels,
} from "./extensionsParts";

export function AttentionRow({ item }: { readonly item: ExtensionAttentionItem }) {
  const gt = useGT();
  const { list, openDetail } = useExtensions();
  const kinds = useKindLabels();
  const subscription = list.subscriptions.find((entry) => entry.instanceId === item.instanceId);
  if (subscription === undefined) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <span className="flex min-w-48 flex-1 items-start gap-2.5">
        <span className="flex h-5 items-center">
          <HealthGlyph health={item.health} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            <span className="min-w-0 truncate font-medium">{item.entry.name}</span>
            <span className="text-xs text-muted-foreground">{kinds.singular(item.entry.kind)}</span>
          </span>
          <span
            className={cn(
              "wrap-anywhere text-xs text-muted-foreground",
              item.health === "failing" && "font-mono",
            )}
          >
            {item.detail ??
              (item.health === "failing"
                ? gt("It could not be reached.")
                : gt("Not signed in on this subscription yet."))}
          </span>
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <ExtensionActions entry={item.entry} subscription={subscription} fixOnly />
        <Button size="xs" variant="ghost" onClick={() => openDetail(item.entry.key)}>
          <T>Details</T>
        </Button>
      </span>
    </div>
  );
}

function ItemRow({
  entry,
  subscription,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
}) {
  const { openDetail } = useExtensions();
  const presence = entry.presence.get(subscription.instanceId);
  if (presence === undefined) return null;
  const health = presenceHealth(presence);
  return (
    <div className={cn("px-3 py-2.5", health === "disabled" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          className="flex min-w-48 flex-1 cursor-pointer items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => openDetail(entry.key)}
        >
          <KindIcon entry={entry} />
          <EntryTitle entry={entry} presence={presence} />
        </button>
        <HealthStatus entry={entry} presence={presence} className="w-28 shrink-0" />
        <span className="flex min-w-24 justify-end">
          <ExtensionActions entry={entry} subscription={subscription} />
        </span>
      </div>
      {needsAttention(health) && presence.detail ? (
        <p
          className={cn(
            "mt-1.5 ps-9.5 wrap-anywhere text-xs",
            health === "failing"
              ? "font-mono text-destructive-foreground"
              : "text-warning-foreground",
          )}
        >
          {presence.detail}
        </p>
      ) : null}
    </div>
  );
}

function KindSection({
  subscription,
  kind,
}: {
  readonly subscription: ExtensionsSubscription;
  readonly kind: ExtensionKind;
}) {
  const gt = useGT();
  const kinds = useKindLabels();
  const { entries, search, openAdd, list } = useExtensions();
  const label = kinds.plural(kind);

  if (!supportsKind(subscription, kind)) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{label}</h2>
        <p className="rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
          {gt("{subscription} doesn't use these. Nothing is missing here.", {
            subscription: subscription.displayName,
          })}
        </p>
      </section>
    );
  }

  const ofKind = entries.filter(
    (entry) => entry.kind === kind && entryMatchesSearch(entry, search),
  );
  const mine = ofKind
    .filter((entry) => entry.presence.has(subscription.instanceId))
    .sort((left, right) =>
      compareHealth(
        presenceHealth(left.presence.get(subscription.instanceId)!),
        presenceHealth(right.presence.get(subscription.instanceId)!),
      ),
    );
  const others = ofKind.filter(
    (entry) => !entry.presence.has(subscription.instanceId) && entryCanCopy(entry),
  );
  const issues = subscription.issues.filter((issue) => issue.kind === kind);
  const otherSubscriptions = list.subscriptions.filter(
    (other) =>
      other.instanceId !== subscription.instanceId &&
      others.some((entry) => entry.presence.has(other.instanceId)),
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="flex items-baseline gap-2 text-sm font-semibold">
          {label}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            {mine.length}
          </span>
        </h2>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {subscription.configHome}
        </span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => openAdd({ kind, instanceId: subscription.instanceId })}
        >
          <PlusIcon />
          <T>Add</T>
        </Button>
      </div>
      {issues.map((issue) => (
        <p
          key={issue.message}
          className="flex items-start gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="wrap-anywhere">{issue.message}</span>
        </p>
      ))}
      {mine.length > 0 ? (
        <SectionCard>
          {mine.map((entry) => (
            <ItemRow key={entry.key} entry={entry} subscription={subscription} />
          ))}
        </SectionCard>
      ) : (
        <p className="rounded-lg border px-3 py-4 text-center text-sm text-muted-foreground">
          {search.trim() !== ""
            ? gt("Nothing matches your search.")
            : others.length > 0
              ? gt("None yet. Add one, or bring one over from another subscription below.")
              : gt("None yet.")}
        </p>
      )}
      {others.length > 0 ? (
        <details className="group/more rounded-lg border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 transition-transform group-open/more:rotate-90"
            />
            <span className="min-w-0 flex-1">
              {kind === "skill"
                ? gt(
                    "{count, plural, one {{count} skill in the shared library, not linked here} other {{count} skills in the shared library, not linked here}}",
                    { count: others.length },
                  )
                : gt("{count} more in your other subscriptions", { count: others.length })}
            </span>
            <span className="flex items-center gap-1.5">
              {otherSubscriptions.map((other) => (
                <SubscriptionIcon key={other.instanceId} subscription={other} size="compact" />
              ))}
            </span>
          </summary>
          <div className="divide-y border-t">
            {others.map((entry) => (
              <OtherRow key={entry.key} entry={entry} subscription={subscription} />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function OtherRow({
  entry,
  subscription,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
}) {
  const { openDetail, list } = useExtensions();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <button
        type="button"
        className="flex min-w-48 flex-1 cursor-pointer items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => openDetail(entry.key)}
      >
        <KindIcon entry={entry} />
        <EntryTitle entry={entry}>
          <span className="flex items-center gap-1.5">
            {list.subscriptions
              .filter((other) => entry.presence.has(other.instanceId))
              .map((other) => (
                <SubscriptionIcon key={other.instanceId} subscription={other} size="compact" />
              ))}
          </span>
        </EntryTitle>
      </button>
      <ExtensionAddHereButton entry={entry} subscription={subscription} />
    </div>
  );
}

export function ExtensionsSubscriptionView({
  subscription,
}: {
  readonly subscription: ExtensionsSubscription;
}) {
  const gt = useGT();
  const { entries, openAdd } = useExtensions();
  const attention = subscriptionAttention(entries, subscription.instanceId);
  const driverLabel = providerClients.get(subscription.driver)?.label ?? subscription.driver;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex min-w-48 flex-1 items-center gap-3">
          <SubscriptionIcon subscription={subscription} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <h1 className="truncate text-lg font-semibold">{subscription.displayName}</h1>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>{driverLabel}</span>
              <span className="truncate font-mono">{subscription.configHome}</span>
            </span>
          </span>
        </span>
        <Button size="sm" onClick={() => openAdd({ instanceId: subscription.instanceId })}>
          <PlusIcon />
          {gt("Add to {subscription}", { subscription: subscription.displayName })}
        </Button>
      </header>

      {attention.length > 0 ? (
        <div className="divide-y divide-warning/20 overflow-hidden rounded-lg border border-warning/32 bg-warning-surface">
          <p className="flex items-center gap-2 px-3 py-2 text-sm font-medium">
            <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
            {gt(
              "{count, plural, one {{count} thing needs attention on this subscription} other {{count} things need attention on this subscription}}",
              { count: attention.length },
            )}
          </p>
          {attention.map((item) => (
            <AttentionRow key={item.entry.key} item={item} />
          ))}
        </div>
      ) : (
        <AllClear>
          {gt("Nothing on {subscription} is failing or waiting for a sign-in.", {
            subscription: subscription.displayName,
          })}
        </AllClear>
      )}

      {EXTENSION_KINDS.map((kind) => (
        <KindSection key={kind} subscription={subscription} kind={kind} />
      ))}
    </div>
  );
}
