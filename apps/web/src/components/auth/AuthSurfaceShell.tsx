import type { ReactNode } from "react";

import { APP_STAGE_LABEL } from "../../branding";
import { resolveEnvironmentIdentificationPillLabel } from "../SidebarStageBackdrop";
import { EnvironmentStagePill, T3CodeWordmark } from "../T3Wordmark";

export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageLabel = resolveEnvironmentIdentificationPillLabel(APP_STAGE_LABEL);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
      <main className="w-full max-w-lg rounded-2xl border bg-card p-6 sm:p-8">
        <div className="flex items-center">
          <T3CodeWordmark />
          {stageLabel ? <EnvironmentStagePill>{stageLabel}</EnvironmentStagePill> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

export function AuthSurfaceMessage({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <>
      <h1 className="mt-6 text-xl font-semibold leading-tight">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}
