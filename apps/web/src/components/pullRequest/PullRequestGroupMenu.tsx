import { useGT, useMessages } from "gt-react";
import { Rows3Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { PullRequestFilterRadioSubmenu } from "./PullRequestListFilters";
import { GROUP_BY_OPTIONS, resolveFilterOptions } from "./pullRequestListOptions";
import {
  DEFAULT_PULL_REQUEST_GROUP_BY,
  DEFAULT_PULL_REQUEST_SUBGROUP_BY,
  type PullRequestGroupBy,
} from "./pullRequestListPreferences";

/** Group the list, and optionally split each group again; both are saved with a view. */
export function PullRequestGroupMenu({
  groupBy,
  subGroupBy,
  onChange,
}: {
  groupBy: PullRequestGroupBy;
  subGroupBy: PullRequestGroupBy;
  onChange: (patch: {
    groupBy?: PullRequestGroupBy | undefined;
    subGroupBy?: PullRequestGroupBy | undefined;
  }) => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const options = resolveFilterOptions(GROUP_BY_OPTIONS, resolve);
  // Involvement is a split of the whole list, so it only makes sense as the first level.
  const subOptions = options
    .filter((option) => option.value !== "involvement" && option.value !== groupBy)
    .map((option) =>
      option.value === "none" ? { ...option, label: gt("No sub-grouping") } : option,
    );
  const subDisabled = groupBy === "none";
  // The route drops a sub-grouping with nothing to split, so `subGroupBy` is always one shown.
  const active =
    Number(groupBy !== DEFAULT_PULL_REQUEST_GROUP_BY) +
    Number(subGroupBy !== DEFAULT_PULL_REQUEST_SUBGROUP_BY);
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" />}>
        <Rows3Icon aria-hidden className="size-4" />
        <span>{gt("Group", { $context: "verb, group a list" })}</span>
        {active > 0 ? (
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
            {active}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <PullRequestFilterRadioSubmenu
          label={gt("Group by", { $context: "pull request grouping" })}
          value={groupBy}
          options={options}
          onChange={(next) => onChange({ groupBy: next })}
        />
        {subDisabled ? null : (
          <PullRequestFilterRadioSubmenu
            label={gt("Then by", { $context: "pull request sub-grouping" })}
            value={subGroupBy}
            options={subOptions}
            onChange={(next) => onChange({ subGroupBy: next })}
          />
        )}
        <MenuSeparator />
        <MenuItem
          disabled={active === 0}
          onClick={() => onChange({ groupBy: undefined, subGroupBy: undefined })}
        >
          {gt("Reset grouping")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
