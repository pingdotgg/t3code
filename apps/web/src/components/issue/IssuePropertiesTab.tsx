import { PinIcon, PinOffIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { IssuePropertyValue } from "./IssuePropertyValue";
import { isEmptyIssuePropertyValue, orderIssueProperties } from "./issueProperties";
import type { IssueProperty } from "@t3tools/contracts";

export function IssuePropertiesTab({
  provider,
  properties: hostProperties,
  pinnedFieldIds,
  onTogglePin,
}: {
  provider: string;
  properties: ReadonlyArray<IssueProperty>;
  pinnedFieldIds: ReadonlyArray<string>;
  onTogglePin: (fieldId: string) => void;
}) {
  const properties = orderIssueProperties(provider, hostProperties);
  const [search, setSearch] = useState("");
  // Jira returns every custom field the site defines, most of them unset on any one issue.
  const [showEmpty, setShowEmpty] = useState(false);
  const query = search.trim().toLowerCase();
  const emptyCount = properties.filter((property) =>
    isEmptyIssuePropertyValue(property.value),
  ).length;
  const filtered = properties.filter(
    (property) =>
      (showEmpty || query !== "" || !isEmptyIssuePropertyValue(property.value)) &&
      `${property.label} ${property.id}`.toLowerCase().includes(query),
  );
  return (
    <section aria-label="Issue properties" className="h-full overflow-y-auto">
      <div className="sticky top-0 z-10 space-y-2 border-b border-border/60 bg-background px-4 py-3">
        <Input
          type="search"
          size="sm"
          aria-label="Search issue properties"
          placeholder="Search fields by name or ID"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {filtered.length} of {properties.length} fields
          </span>
          {emptyCount > 0 && query === "" ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="ml-auto"
              onClick={() => setShowEmpty((value) => !value)}
            >
              {showEmpty ? "Hide empty fields" : `Show ${emptyCount} empty fields`}
            </Button>
          ) : null}
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">No fields match.</p>
      ) : (
        <dl className="px-4 py-1">
          {filtered.map((property) => {
            const pinned = pinnedFieldIds.includes(property.id);
            const label = `${pinned ? "Unpin" : "Pin"} ${property.label}`;
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
                <dd className="min-w-0 pt-0.5 text-foreground">
                  <IssuePropertyValue value={property.value} />
                </dd>
                {/* Unpinned rows show their pin on hover, so the column reads as the pinned set. */}
                <span
                  className={cn(
                    "inline-flex",
                    !pinned && "opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant={pinned ? "secondary" : "ghost-muted"}
                          size="icon-tiny"
                          aria-label={label}
                          aria-pressed={pinned}
                          onClick={() => onTogglePin(property.id)}
                        />
                      }
                    >
                      {pinned ? <PinOffIcon /> : <PinIcon />}
                    </TooltipTrigger>
                    <TooltipPopup>{pinned ? label : `${label} to Summary`}</TooltipPopup>
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
