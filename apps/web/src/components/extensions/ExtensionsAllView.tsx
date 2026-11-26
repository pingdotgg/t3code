// Fork: Kaluwa's Extensions page. Every extension against every subscription.
import type { ExtensionKind, ExtensionsSubscription } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useExtensions } from "./extensionsContext";
import { ExtensionsMatrix, MatrixLegend } from "./ExtensionsMatrix";
import {
  EXTENSION_KINDS,
  type ExtensionEntry,
  attentionCount,
  copyMutation,
  entryDiffers,
  entryHasGap,
  entryMatchesSearch,
  entryMissingIn,
  entryNeedsAttention,
} from "./extensionsModel";
import { EditButton, SubscriptionIcon, useKindLabels } from "./extensionsParts";

type MatrixFilter = "all" | "attention" | "differs" | "gaps";

function isKind(value: string | undefined): value is ExtensionKind {
  return EXTENSION_KINDS.some((kind) => kind === value);
}

function InsightCard({
  tone,
  label,
  count,
  note,
  onClick,
}: {
  readonly tone: "warning" | "info" | "muted";
  readonly label: string;
  readonly count: number;
  readonly note: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex min-w-0 cursor-pointer flex-col gap-1 rounded-lg border bg-card/40 px-3.5 py-3 text-start outline-none hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onClick}
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            count === 0
              ? "bg-success"
              : tone === "warning"
                ? "bg-warning"
                : tone === "info"
                  ? "bg-info"
                  : "bg-muted-foreground/60",
          )}
        />
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums">{count}</span>
      <span className="truncate text-xs text-muted-foreground">{note}</span>
    </button>
  );
}

function BulkBar({
  selected,
  subscriptions,
  onClear,
}: {
  readonly selected: readonly ExtensionEntry[];
  readonly subscriptions: readonly ExtensionsSubscription[];
  readonly onClear: () => void;
}) {
  const gt = useGT();
  const { run } = useExtensions();
  const [busy, setBusy] = useState(false);
  const missingOn = (subscription: ExtensionsSubscription) =>
    selected.filter((entry) =>
      entryMissingIn(entry, subscriptions).some(
        (missing) => missing.instanceId === subscription.instanceId,
      ),
    );
  const targets = subscriptions.filter((subscription) => missingOn(subscription).length > 0);
  const copyTo = async (to: readonly ExtensionsSubscription[]) => {
    setBusy(true);
    await run(
      selected.flatMap((entry) => {
        const ids = to
          .filter((subscription) => missingOn(subscription).includes(entry))
          .map((subscription) => subscription.instanceId);
        const mutation = copyMutation(entry, ids);
        return mutation ? [mutation] : [];
      }),
    );
    setBusy(false);
    onClear();
  };
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-popover px-3 py-2 text-sm shadow-lg">
      <span className="font-medium">{gt("{count} selected", { count: selected.length })}</span>
      {targets.length === 0 ? (
        <span className="text-muted-foreground">
          <T>Already everywhere they can be</T>
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">
            <T>Copy to</T>
          </span>
          {targets.map((subscription) => (
            <Tooltip key={subscription.instanceId}>
              <TooltipTrigger
                render={
                  <EditButton
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void copyTo([subscription])}
                  />
                }
              >
                <SubscriptionIcon subscription={subscription} size="compact" />
                <span className="max-w-28 truncate">{subscription.displayName}</span>
              </TooltipTrigger>
              <TooltipPopup>
                {gt("{count} of the selected are missing on {subscription}", {
                  count: missingOn(subscription).length,
                  subscription: subscription.displayName,
                })}
              </TooltipPopup>
            </Tooltip>
          ))}
          {targets.length > 1 ? (
            <EditButton size="xs" busy={busy} onClick={() => void copyTo(targets)}>
              <T>Everywhere</T>
            </EditButton>
          ) : null}
        </span>
      )}
      <Button size="icon-xs" variant="ghost" aria-label={gt("Clear selection")} onClick={onClear}>
        <XIcon />
      </Button>
    </div>
  );
}

export function ExtensionsAllView() {
  const gt = useGT();
  const kinds = useKindLabels();
  const { list, entries, search, openView } = useExtensions();
  const [kind, setKind] = useState<ExtensionKind>("mcp");
  const [filter, setFilter] = useState<MatrixFilter>("all");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const subscriptions = list.subscriptions;

  const hasGap = (entry: ExtensionEntry) => entryHasGap(entry, subscriptions);
  const matches: Record<MatrixFilter, (entry: ExtensionEntry) => boolean> = {
    all: () => true,
    attention: entryNeedsAttention,
    differs: entryDiffers,
    gaps: hasGap,
  };
  const ofKind = entries.filter((entry) => entry.kind === kind);
  const shown = ofKind.filter(
    (entry) => entryMatchesSearch(entry, search) && matches[filter](entry),
  );
  const groups =
    filter === "all"
      ? [
          { label: gt("Needs attention"), entries: shown.filter(entryNeedsAttention) },
          {
            label: gt("Differs between subscriptions"),
            entries: shown.filter((entry) => !entryNeedsAttention(entry) && entryDiffers(entry)),
          },
          {
            label: gt("Everything else"),
            entries: shown.filter((entry) => !entryNeedsAttention(entry) && !entryDiffers(entry)),
          },
        ]
      : [{ label: "", entries: shown }];
  const attention = attentionCount(list);
  const differing = entries.filter(entryDiffers);
  const gaps = entries.filter(hasGap);
  const selected = entries.filter((entry) => selection.has(entry.key));
  const filters: readonly { value: MatrixFilter; label: string }[] = [
    { value: "all", label: gt("All", { $context: "filter showing every extension" }) },
    { value: "attention", label: gt("Needs attention") },
    { value: "differs", label: gt("Differs") },
    { value: "gaps", label: gt("Gaps", { $context: "extensions missing on some subscriptions" }) },
  ];
  const pick = (next: MatrixFilter, nextKind?: ExtensionKind) => {
    setFilter(next);
    if (nextKind) setKind(nextKind);
    setSelection(new Set());
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">
          <T>All subscriptions</T>
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          <T>
            Each subscription keeps its own extensions and sign-ins. Compare them here, spot gaps
            and differences, and copy across.
          </T>
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <InsightCard
          tone="warning"
          label={gt("Needs attention")}
          count={attention}
          note={
            attention === 0
              ? gt("Nothing is failing or waiting for a sign-in")
              : gt("Failing, or waiting for a sign-in")
          }
          onClick={() => openView({ page: "attention" })}
        />
        <InsightCard
          tone="info"
          label={gt("Differ between subscriptions")}
          count={differing.length}
          note={
            differing.length === 0
              ? gt("Everything shared is set up the same")
              : differing.map((entry) => entry.name).join(", ")
          }
          onClick={() => pick("differs", differing[0]?.kind)}
        />
        <InsightCard
          tone="muted"
          label={gt("Not everywhere they could be")}
          count={gaps.length}
          note={gt("Select rows to copy them across in one go")}
          onClick={() => pick("gaps", gaps[0]?.kind)}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label={gt("Kind of extension")}
          variant="segmented"
          value={[kind]}
          onValueChange={(next) => {
            const value = next[0];
            if (isKind(value)) {
              setKind(value);
              setSelection(new Set());
            }
          }}
        >
          {EXTENSION_KINDS.map((value) => (
            <Toggle key={value} value={value}>
              {kinds.plural(value)}
              <span className="text-muted-foreground tabular-nums">
                {entries.filter((entry) => entry.kind === value).length}
              </span>
            </Toggle>
          ))}
        </ToggleGroup>
        <ToggleGroup
          aria-label={gt("Filter extensions")}
          variant="segmented"
          value={[filter]}
          onValueChange={(next) => {
            const value = filters.find((option) => option.value === next[0]);
            if (value) pick(value.value);
          }}
        >
          {filters.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {option.label}
              <span className="text-muted-foreground tabular-nums">
                {ofKind.filter(matches[option.value]).length}
              </span>
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-10 text-center">
          <p className="text-sm font-medium">
            {ofKind.length === 0 ? gt("None yet") : gt("Nothing matches")}
          </p>
          <p className="text-sm text-muted-foreground">
            {ofKind.length === 0
              ? gt("No subscription has one of these yet.")
              : gt("Try a different filter or search term.")}
          </p>
          {ofKind.length > 0 && filter !== "all" ? (
            <Button size="xs" variant="outline" onClick={() => pick("all")}>
              <T>Show all</T>
            </Button>
          ) : null}
        </div>
      ) : (
        <ExtensionsMatrix
          groups={groups}
          columns={subscriptions}
          nameHeading={kinds.singular(kind)}
          selection={selection}
          onSelect={(key, checked) =>
            setSelection((current) => {
              const next = new Set(current);
              if (checked) next.add(key);
              else next.delete(key);
              return next;
            })
          }
        />
      )}
      <MatrixLegend />
      {selected.length > 0 ? (
        <BulkBar
          selected={selected}
          subscriptions={subscriptions}
          onClear={() => setSelection(new Set())}
        />
      ) : null}
    </div>
  );
}
