import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { usePaginatedBranches } from "../state/queries";
import { Button } from "./ui/button";
import { BranchPicker } from "./BranchPicker";
import { ComboboxItem, ComboboxTrigger } from "./ui/combobox";
import { SelectButton } from "./ui/select";

export function StackBranchPicker({
  environmentId,
  cwd,
  value,
  excluded,
  label,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: string;
  readonly excluded: readonly string[];
  readonly label: string;
  readonly onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const branches = usePaginatedBranches({
    environmentId: open ? environmentId : null,
    cwd,
    query: search,
  });
  const items = branches.refs
    .filter((ref) => !ref.isRemote && !excluded.includes(ref.name))
    .map((ref) => ref.name);
  return (
    <BranchPicker
      items={items}
      filteredItems={items}
      value={value || null}
      query={search}
      onQueryChange={setSearch}
      open={open}
      onOpenChange={setOpen}
      onSelectItem={(branch) => {
        onChange(branch);
        setOpen(false);
      }}
      hasNextPage={branches.data?.nextCursor != null}
      isFetchingNextPage={branches.isFetchingNextPage}
      onLoadNext={branches.loadNext}
      statusText={branches.error ?? (branches.isPending ? "Loading branches…" : null)}
      extraControls={
        branches.data?.nextCursor != null ? (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={branches.isFetchingNextPage}
            onClick={branches.loadNext}
          >
            More branches
          </Button>
        ) : null
      }
      popupProps={{}}
      renderItem={(branch) => (
        <ComboboxItem
          key={branch}
          value={branch}
          onClick={() => {
            onChange(branch);
            setOpen(false);
          }}
        >
          {branch}
        </ComboboxItem>
      )}
    >
      <ComboboxTrigger render={<SelectButton aria-label={label} />}>
        {value || "Choose branch"}
      </ComboboxTrigger>
    </BranchPicker>
  );
}
