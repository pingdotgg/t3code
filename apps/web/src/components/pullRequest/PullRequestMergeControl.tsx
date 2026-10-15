import { useId, useState } from "react";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PullRequestGlyph } from "./pullRequestIcons";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

/** The bypass choice belongs to one merge confirmation and resets whenever it closes. */
export function PullRequestMergeControl({
  label,
  methodLabel,
  baseBranch,
  autoMerge,
  canAdminOverride,
  pending,
  onConfirm,
}: {
  label: string;
  methodLabel: string;
  baseBranch: string;
  autoMerge: boolean;
  canAdminOverride: boolean;
  pending: boolean;
  onConfirm: (adminOverride: boolean) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [bypass, setBypass] = useState(false);
  const checkboxId = useId();
  const inlineConfirm = useInlineActionConfirm(checkboxId);
  const adminOverride = canAdminOverride && bypass;
  const confirmLabel = adminOverride
    ? "Bypass rules and merge"
    : autoMerge
      ? "Enable auto-merge"
      : `Confirm ${methodLabel.toLowerCase()}`;
  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    setBypass(false);
  };
  if (!canAdminOverride) {
    const confirming = inlineConfirm.isArmed("merge");
    return (
      <Button
        size="xs"
        variant="default"
        disabled={pending}
        aria-label={confirming ? confirmLabel : label}
        {...inlineConfirm.props("merge", () => void onConfirm(false))}
      >
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        <span className="@max-[30rem]/pr-header:hidden">
          {pending ? "Working..." : confirming ? confirmLabel : label}
        </span>
      </Button>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpenAndReset}>
      <PopoverTrigger
        render={<Button size="xs" variant="default" disabled={pending} aria-label={label} />}
      >
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        <span className="@max-[30rem]/pr-header:hidden">{pending ? "Working..." : label}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" align="end" aria-label="Confirm pull request merge">
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium">{methodLabel}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {autoMerge && !adminOverride ? (
                "Merge automatically once the requirements are met."
              ) : (
                <>
                  Merge this pull request into <span className="font-mono">{baseBranch}</span>.
                </>
              )}
            </p>
          </div>
          {canAdminOverride ? (
            <label htmlFor={checkboxId} className="flex items-start gap-2 text-xs text-destructive">
              <Checkbox
                id={checkboxId}
                checked={bypass}
                onCheckedChange={setBypass}
                disabled={pending}
              />
              <span>Merge without waiting for requirements to be met (bypass rules)</span>
            </label>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => setOpenAndReset(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant={adminOverride ? "destructive" : "default"}
              disabled={pending}
              onClick={async () => {
                if (await onConfirm(adminOverride)) setOpenAndReset(false);
              }}
            >
              {pending ? "Working..." : confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
