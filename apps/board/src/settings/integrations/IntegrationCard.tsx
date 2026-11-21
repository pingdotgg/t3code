import { LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export interface IntegrationStatus {
  readonly label: string;
  readonly tone: keyof typeof TONE;
}

const TONE = {
  connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  attention: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  neutral: "border-line bg-bg text-muted",
} as const;

export const subordinateRow =
  "flex items-center gap-3 border-t border-line/40 py-2 first:border-t-0";

export function IntegrationCard({
  id,
  icon,
  name,
  description,
  status,
  checking = false,
  actions,
  children,
}: {
  id: string;
  icon: ReactNode;
  name: string;
  description: ReactNode;
  status: IntegrationStatus;
  checking?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-testid="integration-card" data-provider={id} className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <span className="shrink-0 text-muted">{icon}</span>
        <div className="min-w-0 flex-1 basis-64 space-y-0.5">
          <p className="text-sm font-medium text-fg">{name}</p>
          <p className="text-xs text-muted">{description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions}
          {checking ? (
            <LoaderCircle
              className="size-4 shrink-0 animate-spin text-muted"
              aria-label="Checking"
            />
          ) : (
            <span
              data-testid="integration-status"
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${TONE[status.tone]}`}
            >
              {status.label}
            </span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}
