import { T, Var, useGT } from "gt-react";
import { useId, useState } from "react";
import { Button } from "../ui/button";
import { PullRequestAdminMergeOption } from "./PullRequestAdminMergeOption";
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
  blockedReason = null,
  onConfirm,
}: {
  label: string;
  methodLabel: string;
  baseBranch: string;
  autoMerge: boolean;
  canAdminOverride: boolean;
  pending: boolean;
  blockedReason?: string | null;
  onConfirm: (adminOverride: boolean) => Promise<boolean>;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [bypass, setBypass] = useState(false);
  const checkboxId = useId();
  const inlineConfirm = useInlineActionConfirm(checkboxId);
  const adminOverride = canAdminOverride && bypass;
  const confirmLabel = adminOverride
    ? gt("Bypass rules and merge")
    : autoMerge
      ? gt("Enable auto-merge")
      : gt("Confirm {method}", { method: methodLabel.toLowerCase() });
  const setOpenAndReset = (next: boolean) => {
    setOpen(next && blockedReason === null);
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
        aria-disabled={blockedReason !== null || undefined}
        aria-description={blockedReason ?? undefined}
        {...(blockedReason === null
          ? inlineConfirm.props("merge", () => void onConfirm(false))
          : {})}
      >
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        <span className="@max-[30rem]/pr-header:hidden">
          {pending ? gt("Working...") : confirming ? confirmLabel : label}
        </span>
      </Button>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpenAndReset}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="default"
            disabled={pending}
            aria-label={label}
            aria-disabled={blockedReason !== null || undefined}
            aria-description={blockedReason ?? undefined}
          />
        }
      >
        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
        <span className="@max-[30rem]/pr-header:hidden">{pending ? gt("Working...") : label}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" align="end" aria-label={gt("Confirm pull request merge")}>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-medium">{methodLabel}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {autoMerge && !adminOverride ? (
                <T>Merge automatically once the requirements are met.</T>
              ) : (
                <T>
                  Merge this pull request into{" "}
                  <span className="font-mono">
                    <Var>{baseBranch}</Var>
                  </span>
                  .
                </T>
              )}
            </p>
          </div>
          {canAdminOverride ? (
            <PullRequestAdminMergeOption
              checked={bypass}
              onCheckedChange={setBypass}
              disabled={pending}
            />
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => setOpenAndReset(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button
              size="xs"
              variant={adminOverride ? "destructive" : "default"}
              disabled={pending || blockedReason !== null}
              onClick={async () => {
                if (blockedReason !== null) return;
                if (await onConfirm(adminOverride)) setOpenAndReset(false);
              }}
            >
              {pending ? gt("Working...") : confirmLabel}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
