import type { EnvironmentId, IssueListOrder, IssueRef } from "@t3tools/contracts";
import { ArrowDownUpIcon } from "lucide-react";

import { useIssueHistory } from "~/state/issues";

import { PullRequestTimelineGhost } from "../pullRequest/PullRequestGhosts";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { IssueEventRow } from "./IssueConversation";
import { IssueLoadMore } from "./IssueLoadMore";
import { safeIssueExternalUrl } from "./issueAdf";

const ORDER_LABELS = { desc: "Newest first", asc: "Oldest first" } as const;

export function IssueOrderControl({
  order,
  orders,
  onChange,
}: {
  order: IssueListOrder;
  orders?: ReadonlyArray<IssueListOrder> | undefined;
  onChange: (order: IssueListOrder) => void;
}) {
  const supported = orders ?? ["desc", "asc"];
  const effectiveOrder = supported.includes(order) ? order : supported[0];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu>
        <MenuTrigger
          render={
            <Button size="xs" variant="ghost-muted" disabled={effectiveOrder === undefined} />
          }
          aria-label="Activity order"
        >
          <ArrowDownUpIcon aria-hidden className="size-3" />
          {effectiveOrder === undefined ? "Order unavailable" : ORDER_LABELS[effectiveOrder]}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuRadioGroup
            value={effectiveOrder ?? ""}
            onValueChange={(value) => {
              if ((value === "asc" || value === "desc") && supported.includes(value))
                onChange(value);
            }}
          >
            {(["desc", "asc"] as const).map((value) => (
              <MenuRadioItem key={value} value={value} disabled={!supported.includes(value)}>
                {ORDER_LABELS[value]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {supported.length === 1 ? (
        <span className="text-2xs text-muted-foreground">
          This tracker supports {effectiveOrder === "asc" ? "oldest" : "newest"} first only.
        </span>
      ) : null}
    </div>
  );
}

export function IssueHistory({
  environmentId,
  reference,
  order = "desc",
  orders,
  url,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  order?: IssueListOrder | undefined;
  orders?: ReadonlyArray<IssueListOrder> | undefined;
  url?: string | undefined;
}) {
  const effectiveOrder = orders === undefined || orders.includes(order) ? order : orders[0];
  const history = useIssueHistory(
    environmentId,
    effectiveOrder === undefined ? reference : { ...reference, order: effectiveOrder },
  );
  if (history.items.length === 0 && history.isPending) return <PullRequestTimelineGhost rows={5} />;
  if (history.error !== null && history.items.length === 0 && !history.hasMore) {
    return (
      <p className="text-xs text-muted-foreground">
        The history could not be read. {history.error}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {effectiveOrder === undefined || history.truncated ? (
        <p className="text-xs text-muted-foreground">
          {effectiveOrder === undefined
            ? "This tracker cannot read the full history through its API. The shown events are incomplete. Their global order is unavailable."
            : "The tracker returned part of this list."}{" "}
          {url && safeIssueExternalUrl(url) !== null ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground hover:underline"
            >
              Open the issue on the host.
            </a>
          ) : (
            "Open the issue on the host for the rest."
          )}
        </p>
      ) : null}
      {orders?.length === 1 ? (
        <p className="text-2xs text-muted-foreground">
          This tracker supports {effectiveOrder === "asc" ? "oldest" : "newest"} first only.
        </p>
      ) : null}
      {effectiveOrder !== undefined &&
      history.items.length === 0 &&
      !history.hasMore &&
      !history.truncated ? (
        <p className="text-xs text-muted-foreground">No history yet.</p>
      ) : null}
      {history.items.length > 0 ? (
        <ol className="space-y-3 border-l border-border/60 pl-4">
          {history.items.map((event) => (
            <li key={event.id}>
              <IssueEventRow event={event} />
            </li>
          ))}
        </ol>
      ) : null}
      <IssueLoadMore
        key={JSON.stringify([environmentId, reference, effectiveOrder])}
        page={{ ...history, truncated: false }}
        label="Load more history"
      />
    </div>
  );
}
