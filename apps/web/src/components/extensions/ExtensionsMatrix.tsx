// Fork: Kaluwa's Extensions page. Extensions down, subscriptions across.
import type { ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CopyIcon, PlusIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useExtensions } from "./extensionsContext";
import {
  type ExtensionEntry,
  copyMutation,
  shownHealth,
  supportingSubscriptions,
  supportsKind,
} from "./extensionsModel";
import {
  EntryTitle,
  HealthGlyph,
  KindIcon,
  SubscriptionIcon,
  useHealthLabel,
} from "./extensionsParts";

export interface ExtensionsMatrixGroup {
  readonly label: string;
  readonly entries: readonly ExtensionEntry[];
}

const CELL_CLASS =
  "flex min-h-11 items-center justify-center border-s outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function MatrixCell({
  entry,
  subscription,
  presentClick,
}: {
  readonly entry: ExtensionEntry;
  readonly subscription: ExtensionsSubscription;
  readonly presentClick: "detail" | "unlink";
}) {
  const gt = useGT();
  const healthLabel = useHealthLabel();
  const { run, isPending, canEdit, openDetail } = useExtensions();
  const presence = entry.presence.get(subscription.instanceId);
  const name = subscription.displayName;

  if (!supportsKind(subscription, entry.kind)) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className={cn(CELL_CLASS, "text-muted-foreground/50")} />}>
          –
        </TooltipTrigger>
        <TooltipPopup>
          {gt("Not available for {subscription}", { subscription: name })}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (isPending(subscription.instanceId, entry.key)) {
    return (
      <span className={CELL_CLASS}>
        <Spinner size="sm" />
      </span>
    );
  }
  if (presence !== undefined) {
    const unlink = presentClick === "unlink" && presence.skillSource === "library";
    const status = healthLabel(entry, presence);
    const ownCopy = entry.inLibrary && presence.skillSource === "local";
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(CELL_CLASS, "cursor-pointer hover:bg-accent/50")}
              aria-label={gt("{extension} on {subscription}: {status}", {
                extension: entry.name,
                subscription: name,
                status,
              })}
              disabled={unlink && !canEdit}
              onClick={() =>
                unlink
                  ? void run([
                      { _tag: "SkillUnlink", instanceId: subscription.instanceId, name: entry.id },
                    ])
                  : openDetail(entry.key)
              }
            />
          }
        >
          {ownCopy ? (
            <CopyIcon aria-hidden className="size-3.5 text-warning-foreground" />
          ) : (
            <HealthGlyph health={shownHealth(entry.kind, presence)} />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          {ownCopy
            ? gt("{subscription} has its own copy, not the library's. Click for details", {
                subscription: name,
              })
            : unlink
              ? gt("{subscription}: {status}. Click to unlink it", { subscription: name, status })
              : gt("{subscription}: {status}", { subscription: name, status })}
        </TooltipPopup>
      </Tooltip>
    );
  }
  const mutation = copyMutation(entry, [subscription.instanceId]);
  if (mutation === null || !canEdit) return <span className={CELL_CLASS} />;
  const hint =
    entry.kind === "skill"
      ? gt("Not linked to {subscription}. Click to link it", { subscription: name })
      : entry.kind === "plugin"
        ? gt("Not installed on {subscription}. Click to install it", { subscription: name })
        : gt("Not on {subscription}. Click to copy it there", { subscription: name });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              CELL_CLASS,
              "cursor-pointer text-muted-foreground/25 hover:bg-accent/50 hover:text-foreground",
            )}
            aria-label={hint}
            onClick={() => void run([mutation])}
          />
        }
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>{hint}</TooltipPopup>
    </Tooltip>
  );
}

function MatrixRow({
  entry,
  columns,
  selected,
  onSelect,
  presentClick,
}: {
  readonly entry: ExtensionEntry;
  readonly columns: readonly ExtensionsSubscription[];
  readonly selected: boolean;
  readonly onSelect: ((key: string, selected: boolean) => void) | null;
  readonly presentClick: "detail" | "unlink";
}) {
  const gt = useGT();
  const { openDetail, list } = useExtensions();
  const supporting = supportingSubscriptions(list.subscriptions, entry.kind);
  const present = supporting.filter((subscription) => entry.presence.has(subscription.instanceId));
  return (
    <div role="row" className="kaluwa-ext-matrix-row border-t">
      <span className="flex items-center justify-center">
        {onSelect ? (
          <Checkbox
            checked={selected}
            aria-label={gt("Select {name}", { name: entry.name })}
            onCheckedChange={(checked) => onSelect(entry.key, checked)}
          />
        ) : null}
      </span>
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-2.5 py-2 pe-3 outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => openDetail(entry.key)}
      >
        <KindIcon entry={entry} />
        <EntryTitle entry={entry} />
      </button>
      {columns.map((subscription) => (
        <MatrixCell
          key={subscription.instanceId}
          entry={entry}
          subscription={subscription}
          presentClick={presentClick}
        />
      ))}
      <span className="flex items-center justify-end border-s pe-3 text-xs text-muted-foreground tabular-nums">
        {present.length}/{supporting.length}
      </span>
    </div>
  );
}

export function ExtensionsMatrix({
  groups,
  columns,
  nameHeading,
  selection,
  onSelect,
  presentClick = "detail",
}: {
  readonly groups: readonly ExtensionsMatrixGroup[];
  readonly columns: readonly ExtensionsSubscription[];
  readonly nameHeading: string;
  readonly selection?: ReadonlySet<string>;
  readonly onSelect?: (key: string, selected: boolean) => void;
  readonly presentClick?: "detail" | "unlink";
}) {
  const gt = useGT();
  const { openView } = useExtensions();
  const shown = groups.filter((group) => group.entries.length > 0);
  return (
    <div className="overflow-x-auto rounded-lg border bg-card/40">
      <div
        role="table"
        className="kaluwa-ext-matrix"
        style={{ "--kaluwa-ext-cols": columns.length } as CSSProperties}
      >
        <div role="row" className="kaluwa-ext-matrix-row">
          <span />
          <span className="flex items-center py-2 text-xs font-medium text-muted-foreground">
            {nameHeading}
          </span>
          {columns.map((subscription) => (
            <button
              key={subscription.instanceId}
              type="button"
              className="flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 border-s px-1.5 py-2 text-xs outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={gt("Open {subscription}", { subscription: subscription.displayName })}
              onClick={() =>
                openView({ page: "subscription", instanceId: subscription.instanceId })
              }
            >
              <SubscriptionIcon subscription={subscription} size="compact" />
              <span className="w-full truncate text-center">{subscription.displayName}</span>
            </button>
          ))}
          <span className="flex items-center justify-end border-s pe-3 text-xs text-muted-foreground">
            <T>In</T>
          </span>
        </div>
        {shown.map((group) => (
          <div key={group.label} role="rowgroup">
            {group.label !== "" ? (
              <div className="border-t bg-muted/40 px-3 py-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label} · {group.entries.length}
              </div>
            ) : null}
            {group.entries.map((entry) => (
              <MatrixRow
                key={entry.key}
                entry={entry}
                columns={columns}
                selected={selection?.has(entry.key) ?? false}
                onSelect={onSelect ?? null}
                presentClick={presentClick}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MatrixLegend({ linking = false }: { readonly linking?: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <HealthGlyph health="ok" />
        {linking ? <T>Linked</T> : <T>Working</T>}
      </span>
      {linking ? (
        <span className="flex items-center gap-1.5">
          <CopyIcon aria-hidden className="size-3.5 text-warning-foreground" />
          <T>Own copy, not the library's</T>
        </span>
      ) : null}
      {linking ? null : (
        <>
          <span className="flex items-center gap-1.5">
            <HealthGlyph health="needsAuth" />
            <T>Needs sign-in</T>
          </span>
          <span className="flex items-center gap-1.5">
            <HealthGlyph health="failing" />
            <T>Failing</T>
          </span>
          <span className="flex items-center gap-1.5">
            <HealthGlyph health="disabled" />
            <T>Off</T>
          </span>
          <span className="flex items-center gap-1.5">
            <HealthGlyph health="unknown" />
            <T>Not checked</T>
          </span>
        </>
      )}
      <span className="flex items-center gap-1.5">
        <PlusIcon aria-hidden className="size-3.5 opacity-50" />
        {linking ? <T>Not linked, click to link</T> : <T>Not there, click to add</T>}
      </span>
    </p>
  );
}
