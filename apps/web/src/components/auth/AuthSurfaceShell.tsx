import type { ReactNode } from "react";

import { APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveSidebarStageBackdropVariant, StageBackdropArt } from "../SidebarStageBackdrop";
import { StandalonePage } from "../ui/standalone-page";

/**
 * Branded masthead for the CLI-connect authorize and callback pages.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const stageVariant = resolveSidebarStageBackdropVariant(APP_STAGE_LABEL);

  return (
    <StandalonePage
      tone="brand"
      masthead={
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
      }
    >
      {children}
    </StandalonePage>
  );
}
