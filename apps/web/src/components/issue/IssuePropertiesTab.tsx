import {
  ISSUE_PROPERTY_PIN_LIMIT,
  isEmptyIssuePropertyValue,
  pinnedIssueProperties,
  visibleIssueProperties,
} from "@t3tools/client-runtime/issue-properties";
import type { IssueDetail, IssueProperty } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PinIcon, PinOffIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { PullRequestMetaRow } from "../pullRequest/PullRequestSummaryTab";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssuePropertyValue } from "./IssuePropertyValue";
import { useIssuePropertyPins } from "./useIssuePropertyPins";

/** Unpinned rows show their pin on hover, so the column reads as the pinned set. */
const REVEAL_ON_HOVER =
  "sm:opacity-0 sm:group-hover:opacity-100 sm:has-[:focus-visible]:opacity-100";

/** The pinned fields' current values, beside the labels and assignees on the summary. */
export function IssuePinnedProperties({
  issue,
  properties,
}: {
  issue: IssueDetail;
  properties: ReadonlyArray<IssueProperty>;
}) {
  const gt = useGT();
  const pins = useIssuePropertyPins(issue);
  return pinnedIssueProperties(properties, pins.ids).map((property) => (
    <div key={property.id} className="group">
      <PullRequestMetaRow icon={<PinIcon className="size-3.5" />} label={property.label}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0">
            <IssuePropertyValue value={property.value} />
          </span>
          <span className={cn("inline-flex shrink-0", REVEAL_ON_HOVER)}>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={gt("Unpin {field}", { field: property.label })}
              onClick={() => pins.toggle(property.id)}
            >
              <PinOffIcon />
            </Button>
          </span>
        </span>
      </PullRequestMetaRow>
    </div>
  ));
}

export function IssuePropertiesTab({
  issue,
  properties,
}: {
  issue: IssueDetail;
  properties: ReadonlyArray<IssueProperty>;
}) {
  const gt = useGT();
  const pins = useIssuePropertyPins(issue);
  const [search, setSearch] = useState("");
  // Jira and Azure DevOps report every field a site defines, most of them unset on one issue.
  const [showEmpty, setShowEmpty] = useState(false);
  const visible = visibleIssueProperties(properties, search, showEmpty);
  const hasEmpty = properties.some((property) => isEmptyIssuePropertyValue(property.value));
  return (
    <section aria-label={gt("Issue properties")} className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 space-y-2 border-b border-border/60 bg-background px-4 py-3">
        <Input
          type="search"
          size="sm"
          aria-label={gt("Search issue properties")}
          placeholder={gt("Search fields by name or ID")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {gt("{shown} of {total}", { shown: visible.length, total: properties.length })}
          </span>
          {hasEmpty && search.trim() === "" ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="ml-auto"
              onClick={() => setShowEmpty(!showEmpty)}
            >
              {showEmpty ? <T>Hide empty fields</T> : <T>Show empty fields</T>}
            </Button>
          ) : null}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">
          <T>No fields match.</T>
        </p>
      ) : (
        <dl className="px-4 py-1">
          {visible.map((property) => {
            const pinned = pins.ids.includes(property.id);
            const action = pinned
              ? gt("Unpin {field}", { field: property.label })
              : gt("Pin {field}", { field: property.label });
            return (
              <div
                key={property.id}
                className="group grid min-w-0 grid-cols-[minmax(6rem,min(40%,12rem))_minmax(0,1fr)_auto] items-start gap-3 border-b border-border/40 py-2 text-xs last:border-b-0"
              >
                <dt className="min-w-0 pt-0.5 text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate" />}>
                      {property.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {property.label === property.id
                        ? property.id
                        : `${property.label} (${property.id})`}
                    </TooltipPopup>
                  </Tooltip>
                </dt>
                <dd className="min-w-0 pt-0.5">
                  <IssuePropertyValue value={property.value} />
                </dd>
                <span className={cn("inline-flex", !pinned && REVEAL_ON_HOVER)}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant={pinned ? "secondary" : "ghost-muted"}
                          aria-label={action}
                          disabled={!pinned && pins.ids.length >= ISSUE_PROPERTY_PIN_LIMIT}
                          onClick={() => pins.toggle(property.id)}
                        />
                      }
                    >
                      <PinIcon className={cn(pinned && "fill-current")} />
                    </TooltipTrigger>
                    <TooltipPopup>{action}</TooltipPopup>
                  </Tooltip>
                </span>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
