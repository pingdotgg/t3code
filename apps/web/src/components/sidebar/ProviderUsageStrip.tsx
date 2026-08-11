import { type ProviderBankedReset, type ProviderQuotaConsumeResetInput } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BotIcon } from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { usePrimarySettings } from "../../hooks/useSettings";
import { type PrimaryProviderQuotaState, usePrimaryProviderQuota } from "../../state/providerQuota";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DRIVER_OPTIONS } from "../settings/providerDriverMeta";
import {
  deriveOrderedProviderSettingsRows,
  resolvePrimaryOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "../ui/sheet";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ProviderQuotaDetails,
  ProviderQuotaResetConfirmationContent,
} from "./ProviderQuotaDetails";
import {
  buildProviderUsageStripItems,
  cancelProviderResetAttempt,
  confirmProviderResetAttempt,
  createProviderResetAttemptState,
  providerUsageAriaLabel,
  settleProviderResetAttempt,
  type ProviderResetAttemptState,
  type ProviderUsageStripItem,
} from "./ProviderUsageStrip.logic";

function ProviderUsageButton({ item }: { readonly item: ProviderUsageStripItem }) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[item.driver] ?? BotIcon;
  return (
    <button
      aria-label={providerUsageAriaLabel(item)}
      className="inline-flex h-6 w-[3.75rem] shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      type="button"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="w-7 text-center tabular-nums">
        {item.percentage === null ? "—" : `${item.percentage}%`}
      </span>
    </button>
  );
}

function providerUsageTooltip(item: ProviderUsageStripItem): string {
  const label = providerUsageAriaLabel(item);
  if (item.snapshot?.lastSuccessfulReadAt) {
    return `${label}. Last successful read ${item.snapshot.lastSuccessfulReadAt}`;
  }
  return `${label}. No successful read is available`;
}

function consumeErrorMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "detail" in error) {
    const detail = Reflect.get(error, "detail");
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The reset request could not be completed. Try again.";
}

const ProviderUsageItemSurface = memo(function ProviderUsageItemSurface({
  canOperate,
  isSmallScreen,
  item,
  onConsumeReset,
}: {
  readonly canOperate: boolean;
  readonly isSmallScreen: boolean;
  readonly item: ProviderUsageStripItem;
  readonly onConsumeReset: PrimaryProviderQuotaState["consumeReset"];
}) {
  const [attempt, setAttempt] = useState(createProviderResetAttemptState);
  const attemptRef = useRef(attempt);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [selectedReset, setSelectedReset] = useState<ProviderBankedReset | null>(null);

  const updateAttempt = useCallback((next: ProviderResetAttemptState) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);

  const requestReset = useCallback(
    (reset: ProviderBankedReset) => {
      if (attemptRef.current.pending) return;
      if (selectedReset !== null && selectedReset.id !== reset.id) {
        updateAttempt(cancelProviderResetAttempt(attemptRef.current));
      }
      setSelectedReset(reset);
      setConfirmationOpen(true);
    },
    [selectedReset, updateAttempt],
  );

  const cancelReset = useCallback(() => {
    if (attemptRef.current.pending) return;
    updateAttempt(cancelProviderResetAttempt(attemptRef.current));
    setConfirmationOpen(false);
    setSelectedReset(null);
  }, [updateAttempt]);

  const confirmReset = useCallback(async () => {
    if (selectedReset === null || attemptRef.current.pending) return;
    const confirmed = confirmProviderResetAttempt(attemptRef.current, () => {
      // @effect-diagnostics-next-line cryptoRandomUUID:off -- The wire contract explicitly requires a browser-generated idempotency key.
      return crypto.randomUUID();
    });
    updateAttempt(confirmed);
    const input: ProviderQuotaConsumeResetInput = {
      instanceId: item.instanceId,
      creditId: selectedReset.id,
      idempotencyKey: confirmed.idempotencyKey!,
    };
    const result = await onConsumeReset(input);

    if (result?._tag === "Success") {
      const settled = settleProviderResetAttempt(confirmed, {
        kind: "outcome",
        outcome: result.value,
      });
      updateAttempt(settled);
      setConfirmationOpen(false);
      setSelectedReset(null);
      toastManager.add({
        type: result.value === "reset" ? "success" : "info",
        title: "Provider reset",
        description: settled.feedback ?? undefined,
      });
      return;
    }

    const message =
      result === null
        ? "The reset request could not be sent. Try again."
        : consumeErrorMessage(result);
    updateAttempt(settleProviderResetAttempt(confirmed, { kind: "transportError", message }));
    setConfirmationOpen(false);
    toastManager.add({ type: "error", title: "Provider reset failed", description: message });
  }, [item.instanceId, onConsumeReset, selectedReset, updateAttempt]);

  const detail = (
    <ProviderQuotaDetails
      canOperate={canOperate}
      feedback={attempt.feedback}
      item={item}
      onRequestReset={requestReset}
      pendingReset={attempt.pending}
    />
  );
  const button = <ProviderUsageButton item={item} />;

  return (
    <>
      <Tooltip>
        {isSmallScreen ? (
          <Sheet>
            <TooltipTrigger render={<SheetTrigger render={button} />} />
            <SheetPopup className="max-h-[85dvh]" side="bottom">
              <SheetHeader className="sr-only">
                <SheetTitle>{item.displayName} quota</SheetTitle>
                <SheetDescription>Provider quota details</SheetDescription>
              </SheetHeader>
              <SheetPanel className="pt-5">{detail}</SheetPanel>
            </SheetPopup>
          </Sheet>
        ) : (
          <Popover>
            <TooltipTrigger render={<PopoverTrigger render={button} />} />
            <PopoverPopup
              align="start"
              className="w-[22rem] max-w-[calc(100vw-2rem)]"
              side="top"
              sideOffset={8}
            >
              {detail}
            </PopoverPopup>
          </Popover>
        )}
        <TooltipPopup>{providerUsageTooltip(item)}</TooltipPopup>
      </Tooltip>

      {selectedReset === null ? null : (
        <AlertDialog
          open={confirmationOpen}
          onOpenChange={(open) => {
            if (!open && attemptRef.current.pending) return;
            if (!open) cancelReset();
            else setConfirmationOpen(true);
          }}
        >
          <AlertDialogPopup
            aria-label={`Confirm ${selectedReset.title ?? selectedReset.resetType}`}
          >
            <ProviderQuotaResetConfirmationContent
              onCancel={cancelReset}
              onConfirm={() => void confirmReset()}
              pending={attempt.pending}
              reset={selectedReset}
            />
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </>
  );
});

export const ProviderUsageStripView = memo(function ProviderUsageStripView({
  canOperate,
  isSmallScreen,
  items,
  onConsumeReset,
}: {
  readonly canOperate: boolean;
  readonly isSmallScreen: boolean;
  readonly items: ReadonlyArray<ProviderUsageStripItem>;
  readonly onConsumeReset: PrimaryProviderQuotaState["consumeReset"];
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="flex h-7 min-w-0 max-w-full items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-slot="provider-usage-strip"
    >
      {items.map((item) => (
        <ProviderUsageItemSurface
          key={item.instanceId}
          canOperate={canOperate}
          isSmallScreen={isSmallScreen}
          item={item}
          onConsumeReset={onConsumeReset}
        />
      ))}
    </div>
  );
});

export function ProviderUsageStrip() {
  const settings = usePrimarySettings();
  const quota = usePrimaryProviderQuota();
  const isSmallScreen = useMediaQuery("max-sm");
  const sessionState = usePrimarySessionState();
  const rows = useMemo(
    () =>
      deriveOrderedProviderSettingsRows({
        settings,
        driverOrder: DRIVER_OPTIONS.map((option) => option.value),
      }),
    [settings],
  );
  const items = useMemo(
    () => buildProviderUsageStripItems({ rows, summary: quota.summary }),
    [quota.summary, rows],
  );
  const canOperate =
    resolvePrimaryOperateAccess({
      isPrimary: true,
      hasDesktopBridge: isElectron,
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.error !== null,
    }) === "granted";

  return (
    <ProviderUsageStripView
      canOperate={canOperate}
      isSmallScreen={isSmallScreen}
      items={items}
      onConsumeReset={quota.consumeReset}
    />
  );
}
