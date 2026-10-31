// Menu typeahead consumes search keystrokes; use a combobox.
import { Fragment, type ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestPeopleGhost } from "./PullRequestGhosts";

export function PullRequestCandidatePicker<T>({
  icon,
  label,
  allowed,
  disabledReason,
  open,
  onOpenChange,
  query,
  onQueryChange,
  searchLabel,
  isPending,
  error,
  candidates,
  emptyLabel,
  noMatchLabel,
  errorLabel,
  truncated,
  truncatedLabel,
  candidateKey,
  disabled,
  onSelect,
  groupLabel,
  footer,
  children,
}: {
  icon: ReactNode;
  label: string;
  allowed: boolean;
  disabledReason: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  isPending: boolean;
  error: string | null;
  candidates: ReadonlyArray<T>;
  emptyLabel: string;
  noMatchLabel: string;
  errorLabel: string;
  truncated: boolean;
  truncatedLabel: string;
  candidateKey: (candidate: T) => string;
  disabled: boolean;
  onSelect: (candidate: T) => void;
  /**
   * The heading of the group a candidate belongs to, such as "Suggested". The caller orders the
   * candidates by group; a heading is drawn wherever the group changes.
   */
  groupLabel?: ((candidate: T) => string | null) | undefined;
  /** A line pinned under the list, such as how many labels are applied. */
  footer?: ReactNode;
  children: (candidate: T) => ReactNode;
}) {
  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" aria-disabled="true" aria-label={label}>
              {icon}
            </Button>
          }
        />
        <TooltipPopup side="bottom">{disabledReason}</TooltipPopup>
      </Tooltip>
    );
  }

  const keys = candidates.map(candidateKey);

  return (
    <Combobox
      items={keys}
      filteredItems={keys}
      filter={null}
      autoHighlight
      value={null}
      onValueChange={(key) => {
        const candidate = candidates.find((entry) => candidateKey(entry) === key);
        if (candidate) onSelect(candidate);
      }}
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Item-press closure steals search focus and the next keystroke.
        if (!nextOpen && details.reason === "item-press") {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <ComboboxTrigger
        render={
          <Button size="icon-xs" variant="ghost" aria-label={label}>
            {icon}
          </Button>
        }
      />
      <ComboboxPopup align="start" side="bottom" className="w-72">
        <ComboboxSearchInput
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <ComboboxList className="max-h-72">
          {isPending ? (
            <PullRequestPeopleGhost rows={4} />
          ) : error !== null ? (
            <p className="p-2 text-meta text-muted-foreground">
              {errorLabel} {error}
            </p>
          ) : candidates.length === 0 ? (
            <p className="p-2 text-meta text-muted-foreground">
              {query.length > 0 ? noMatchLabel : emptyLabel}
            </p>
          ) : (
            candidates.map((candidate, index) => {
              const group = groupLabel?.(candidate) ?? null;
              const before = index > 0 ? candidates[index - 1] : undefined;
              const previous = before === undefined ? null : (groupLabel?.(before) ?? null);
              return (
                <Fragment key={keys[index]}>
                  {group !== null && (index === 0 || group !== previous) ? (
                    <p className="px-2 pt-2 pb-1 text-meta text-muted-foreground">{group}</p>
                  ) : null}
                  <ComboboxItem hideIndicator index={index} value={keys[index]} disabled={disabled}>
                    {children(candidate)}
                  </ComboboxItem>
                </Fragment>
              );
            })
          )}
          {truncated ? (
            <p className="px-2 py-1.5 text-meta text-muted-foreground">{truncatedLabel}</p>
          ) : null}
        </ComboboxList>
        {footer ? (
          <div className="border-t border-border px-3 py-2 text-meta text-muted-foreground">
            {footer}
          </div>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
