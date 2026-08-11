import {
  type ProviderBankedReset,
  type ProviderInstanceId,
  type ProviderQuotaConsumeResetInput,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BotIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySessionState } from "../../environments/primary";
import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { type PrimaryProviderQuotaState, usePrimaryProviderQuota } from "../../state/providerQuota";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { DRIVER_OPTIONS } from "../settings/providerDriverMeta";
import {
  deriveVisibleOrderedProviderSettingsRows,
  resolvePrimaryOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import type { ProviderUsageStripItem } from "../sidebar/ProviderUsageStrip.logic";
import { buildProviderUsageStripItems } from "../sidebar/ProviderUsageStrip.logic";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";
import {
  ProviderQuotaDetails,
  ProviderQuotaResetConfirmationContent,
} from "./ProviderQuotaDetails";
import {
  cancelProviderResetAttempt,
  confirmProviderResetAttempt,
  createProviderResetAttemptState,
  resolveSelectedProviderQuotaItem,
  settleProviderResetAttempt,
  type ConfirmedProviderResetAttemptState,
  type ProviderResetAttemptState,
} from "./ProviderQuotaSection.logic";

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

export function prepareProviderResetConsumption(input: {
  readonly attempt: ProviderResetAttemptState;
  readonly instanceId: ProviderQuotaConsumeResetInput["instanceId"];
  readonly creditId: ProviderQuotaConsumeResetInput["creditId"];
}): {
  readonly attempt: ConfirmedProviderResetAttemptState;
  readonly input: ProviderQuotaConsumeResetInput;
} {
  const attempt = confirmProviderResetAttempt(input.attempt, input.creditId, randomUUID);
  return {
    attempt,
    input: {
      instanceId: input.instanceId,
      creditId: input.creditId,
      idempotencyKey: attempt.idempotencyKey,
    },
  };
}

function ProviderQuotaSelector({
  item,
  onSelect,
  selected,
}: {
  readonly item: ProviderUsageStripItem;
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
  readonly selected: boolean;
}) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[item.driver] ?? BotIcon;
  const percentage = item.percentage === null ? null : Math.min(100, Math.max(0, item.percentage));
  return (
    <button
      aria-label={`Show ${item.displayName} usage limits`}
      aria-pressed={selected}
      className={cn(
        "min-w-36 shrink-0 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors active:translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none",
        selected
          ? "border-foreground/25 bg-muted/50 text-foreground"
          : "border-border/70 text-muted-foreground hover:border-border hover:bg-muted/25 hover:text-foreground",
      )}
      onClick={() => onSelect(item.instanceId)}
      type="button"
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate text-xs font-medium">{item.displayName}</span>
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {percentage === null ? "—" : `${percentage}%`}
        </span>
      </span>
      <span className="mt-2 block h-1 overflow-hidden rounded-full bg-muted">
        {percentage === null ? null : (
          <span
            className="block h-full rounded-full bg-foreground/70"
            style={{ width: `${percentage}%` }}
          />
        )}
      </span>
    </button>
  );
}

const ProviderQuotaSelectedSurface = memo(function ProviderQuotaSelectedSurface({
  canOperate,
  item,
  onConsumeReset,
}: {
  readonly canOperate: boolean;
  readonly item: ProviderUsageStripItem;
  readonly onConsumeReset: PrimaryProviderQuotaState["consumeReset"];
}) {
  const [attempt, setAttempt] = useState(createProviderResetAttemptState);
  const attemptRef = useRef(attempt);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [selectedReset, setSelectedReset] = useState<ProviderBankedReset | null | undefined>();

  const updateAttempt = useCallback((next: ProviderResetAttemptState) => {
    attemptRef.current = next;
    setAttempt(next);
  }, []);
  const requestReset = useCallback(
    (reset: ProviderBankedReset | null) => {
      if (attemptRef.current.pending) return;
      const selectedCreditId = selectedReset?.id ?? null;
      const nextCreditId = reset?.id ?? null;
      if (selectedReset !== undefined && selectedCreditId !== nextCreditId) {
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
    setSelectedReset(undefined);
  }, [updateAttempt]);
  const confirmReset = useCallback(async () => {
    if (selectedReset === undefined || attemptRef.current.pending) return;
    const prepared = prepareProviderResetConsumption({
      attempt: attemptRef.current,
      instanceId: item.instanceId,
      creditId: selectedReset?.id ?? null,
    });
    const confirmed = prepared.attempt;
    updateAttempt(confirmed);
    const result = await onConsumeReset(prepared.input);

    if (result?._tag === "Success") {
      const settled = settleProviderResetAttempt(confirmed, {
        kind: "outcome",
        outcome: result.value,
      });
      updateAttempt(settled);
      setConfirmationOpen(false);
      setSelectedReset(undefined);
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

  return (
    <>
      <ProviderQuotaDetails
        canOperate={canOperate}
        feedback={attempt.feedback}
        item={item}
        onRequestReset={requestReset}
        pendingReset={attempt.pending}
      />
      {selectedReset === undefined ? null : (
        <AlertDialog
          open={confirmationOpen}
          onOpenChange={(open) => {
            if (!open && attemptRef.current.pending) return;
            if (!open) cancelReset();
            else setConfirmationOpen(true);
          }}
        >
          <AlertDialogPopup>
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

export const ProviderQuotaSectionView = memo(function ProviderQuotaSectionView({
  canOperate,
  items,
  onConsumeReset,
  onSelect,
  selectedItem,
}: {
  readonly canOperate: boolean;
  readonly items: ReadonlyArray<ProviderUsageStripItem>;
  readonly onConsumeReset: PrimaryProviderQuotaState["consumeReset"];
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
  readonly selectedItem: ProviderUsageStripItem | null;
}) {
  if (items.length === 0 || selectedItem === null) return null;
  return (
    <section className="scroll-mt-6 border-y border-border py-5" id="provider-limits">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Live allowance</p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
            Usage limits
          </h1>
        </div>
        <p className="text-xs text-muted-foreground">Updates automatically</p>
      </div>
      <div
        aria-label="Provider usage limits"
        className="mt-4 flex gap-2 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:thin]"
      >
        {items.map((item) => (
          <ProviderQuotaSelector
            key={item.instanceId}
            item={item}
            onSelect={onSelect}
            selected={item.instanceId === selectedItem.instanceId}
          />
        ))}
      </div>
      <div className="mt-5 border-t border-border pt-5">
        <ProviderQuotaSelectedSurface
          key={selectedItem.instanceId}
          canOperate={canOperate}
          item={selectedItem}
          onConsumeReset={onConsumeReset}
        />
      </div>
    </section>
  );
});

export function ProviderQuotaSection({
  onSelect,
  requestedInstanceId,
}: {
  readonly onSelect: (instanceId: ProviderInstanceId) => void;
  readonly requestedInstanceId: ProviderInstanceId | null;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const config = primaryEnvironment?.serverConfig ?? null;
  const quota = usePrimaryProviderQuota();
  const sessionState = usePrimarySessionState();
  const rows = useMemo(
    () =>
      config === null
        ? []
        : deriveVisibleOrderedProviderSettingsRows({
            settings: config.settings,
            driverOrder: DRIVER_OPTIONS.map((option) => option.value),
            serverProviders: config.providers,
          }),
    [config],
  );
  const items = useMemo(
    () => buildProviderUsageStripItems({ rows, summary: quota.summary }),
    [quota.summary, rows],
  );
  const selectedItem = resolveSelectedProviderQuotaItem(items, requestedInstanceId);
  useEffect(() => {
    if (selectedItem !== null && selectedItem.instanceId !== requestedInstanceId) {
      onSelect(selectedItem.instanceId);
    }
  }, [onSelect, requestedInstanceId, selectedItem]);
  const canOperate =
    resolvePrimaryOperateAccess({
      isPrimary: true,
      hasDesktopBridge: isElectron,
      session: sessionState.data,
      isPending: sessionState.isPending,
      hasError: sessionState.error !== null,
    }) === "granted";

  return (
    <ProviderQuotaSectionView
      canOperate={canOperate}
      items={items}
      onConsumeReset={quota.consumeReset}
      onSelect={onSelect}
      selectedItem={selectedItem}
    />
  );
}
