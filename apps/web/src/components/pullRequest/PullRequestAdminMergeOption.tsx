import { useId } from "react";
import { Checkbox } from "../ui/checkbox";

export function PullRequestAdminMergeOption({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-xs text-destructive">
      <Checkbox id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      <span>Merge with admin permissions</span>
    </label>
  );
}
