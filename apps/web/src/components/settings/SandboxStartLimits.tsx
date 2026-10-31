import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  assessSandboxStart,
  type EnvironmentId,
  isSandboxProviderError,
  type SandboxProviderErrorCode,
  type SandboxProviderInfo,
  type SandboxProviderLimits,
  type SandboxStartAssessment,
} from "@t3tools/contracts";

import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

const WINDOW_LABELS = { minute: "min", hour: "h", day: "day" } as const;

const FAILURE_TITLES: Record<SandboxProviderErrorCode, string | null> = {
  api_key_rejected: "API key rejected",
  rate_limited: "Start limit reached",
  concurrency_full: "No free sandbox slots",
  billing_required: "Billing needs attention",
  size_unavailable: "Machine size not available",
  snapshot_expired: "Sandbox disk expired",
  capacity_unavailable: "Provider is out of machines",
  not_found: "Sandbox not found",
  unknown: null,
};

/** A toast title and message for a failed sandbox action, using the provider's stable code. */
export const describeSandboxFailure = (
  error: unknown,
  fallbackTitle: string,
): { readonly title: string; readonly description: string } => {
  if (isSandboxProviderError(error)) {
    return {
      title: (error.code === undefined ? null : FAILURE_TITLES[error.code]) ?? fallbackTitle,
      description: error.detail,
    };
  }
  return {
    title: fallbackTitle,
    description: error instanceof Error ? error.message : "The sandbox action failed.",
  };
};

const formatLifetime = (minutes: number) =>
  minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;

/**
 * Reads the provider's limits for a configured provider and decides whether the next start is
 * blocked or needs confirming. A start with warnings needs one explicit confirmation, which lapses
 * when the warnings change.
 */
export function useSandboxStartCheck(input: {
  readonly environmentId: EnvironmentId;
  readonly provider: SandboxProviderInfo | undefined;
  readonly size?: string;
}) {
  const { provider } = input;
  const query = useEnvironmentQuery(
    provider !== undefined && provider.configured && provider.capabilities.limits
      ? serverEnvironment.sandboxesLimits({
          environmentId: input.environmentId,
          input: { provider: provider.kind },
        })
      : null,
  );
  const [openedAt] = useState(() => Date.now());
  const [confirming, setConfirming] = useState<string | null>(null);
  const limits = query.data?.limits ?? null;
  const assessment: SandboxStartAssessment | null =
    limits === null || provider === undefined
      ? null
      : assessSandboxStart(limits, {
          providerLabel: provider.label,
          nowMillis: openedAt,
          ...(input.size === undefined || input.size === "" ? {} : { size: input.size }),
        });
  const warningsKey = assessment?.warnings.join("\n") ?? "";
  return {
    limits,
    assessment,
    blocked: assessment?.blocked ?? null,
    isConfirming: warningsKey !== "" && confirming === warningsKey,
    /** True when the click should open the confirmation instead of starting. */
    needsConfirmation: warningsKey !== "" && confirming !== warningsKey,
    confirm: () => setConfirming(warningsKey),
    cancel: () => setConfirming(null),
    refresh: () => {
      setConfirming(null);
      query.refresh();
    },
  };
}

export function SandboxQuotaLine({
  limits,
  defaultTtlMinutes,
}: {
  readonly limits: SandboxProviderLimits;
  /** The lifetime T3 asks for; a lower plan maximum is called out. */
  readonly defaultTtlMinutes?: number;
}) {
  const parts: Array<{ readonly key: string; readonly node: ReactNode }> = [];
  if (limits.plan !== undefined) parts.push({ key: "plan", node: limits.plan });
  if (limits.starts !== undefined && limits.starts.length > 0) {
    parts.push({
      key: "starts",
      node: (
        <>
          Starts left{" "}
          {limits.starts.map((window, index) => {
            const low = window.remaining <= Math.max(2, Math.ceil(window.limit / 10));
            return (
              <span key={window.window}>
                {index === 0 ? "" : " · "}
                <span className={low ? "text-warning" : "text-foreground"}>{window.remaining}</span>
                /{WINDOW_LABELS[window.window]}
              </span>
            );
          })}
        </>
      ),
    });
  }
  if (limits.concurrency !== undefined) {
    parts.push({
      key: "running",
      node: (
        <>
          <span className="text-foreground">{limits.concurrency.active}</span> of{" "}
          {limits.concurrency.max} running
        </>
      ),
    });
  }
  if (
    limits.maxTtlMinutes !== undefined &&
    defaultTtlMinutes !== undefined &&
    limits.maxTtlMinutes < defaultTtlMinutes
  ) {
    parts.push({ key: "ttl", node: `stops after ${formatLifetime(limits.maxTtlMinutes)}` });
  }
  if (parts.length === 0) return null;
  return (
    <p className="text-2xs text-muted-foreground tabular-nums">
      {parts.map((part, index) => (
        <span key={part.key}>
          {index === 0 ? "" : " · "}
          {part.node}
        </span>
      ))}
    </p>
  );
}

export function SandboxStartBlocked({
  reason,
  billingUrl,
}: {
  readonly reason: string;
  readonly billingUrl: string | undefined;
}) {
  return (
    <Alert variant="error">
      <AlertDescription>
        <span>
          {reason}
          {billingUrl === undefined ? null : (
            <>
              {" "}
              <a
                href={billingUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
              >
                Open billing
                <ExternalLinkIcon aria-hidden className="size-3" />
              </a>
            </>
          )}
        </span>
      </AlertDescription>
    </Alert>
  );
}

export function SandboxStartConfirmation({
  warnings,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  readonly warnings: ReadonlyArray<string>;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <Alert variant="warning">
      <AlertDescription>
        {warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button size="xs" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </AlertAction>
    </Alert>
  );
}
