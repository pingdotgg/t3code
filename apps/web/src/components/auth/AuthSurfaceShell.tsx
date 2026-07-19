import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";

/**
 * Full-screen card for standalone auth pages, mirroring the pairing surface's
 * treatment. Used by the CLI-connect authorize and callback surfaces.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(48rem_20rem_at_top,color-mix(in_srgb,var(--color-blue-500)_12%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_94%,var(--color-black))_0%,var(--background)_62%)]" />
      </div>

      <section className="relative w-full max-w-xl overflow-hidden rounded-2xl border border-border/80 bg-card/94 shadow-2xl shadow-black/20 backdrop-blur-md">
        <header className="relative h-24 overflow-hidden bg-[linear-gradient(135deg,#1e61de,#17348e)] text-white">
          {stageVariant ? (
            <div className="absolute inset-0" aria-hidden>
              <StageBackdropArt variant={stageVariant} />
            </div>
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(circle_at_75%_25%,rgba(136,204,255,0.5),transparent_38%),linear-gradient(135deg,#2468df,#172f82)]"
            />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_20%,rgba(7,18,55,0.46)_100%)]" />
          <div className="relative h-full p-5 sm:p-6">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-white/80 uppercase">
              {APP_DISPLAY_NAME}
            </p>
          </div>
        </header>

        <div className="p-6 sm:p-8">{children}</div>
      </section>
    </div>
  );
}
