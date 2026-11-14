import { ArrowUpIcon, MicIcon, PaperclipIcon } from "lucide-react";

import { ComposerSurface } from "../components/chat/ComposerSurface";
import { DEFAULT_COMPOSER_PLACEHOLDER } from "../composerPlaceholder";
import { orbitComposerControls } from "./orbitComposerControls";

/**
 * Conn: the prompt box of a thread whose Orbit Instance is still being made. It shows from the
 * moment of send, in the composer's place and look, disabled (dimmed, not typeable, send off);
 * the real thread's composer takes over in the same place and enables once the Instance is ready.
 */
export function OrbitPendingComposer({ startId }: { startId: string }) {
  // The draft's own model button, copied at send; inert here like the rest of the box.
  const controls = orbitComposerControls(startId);
  return (
    <div
      data-orbit-pending-composer
      data-orbit-composer-locked="true"
      inert
      className="chat-composer-lane w-full shrink-0 bg-background pt-2 pb-5"
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main className="opacity-50">
            <div className="rounded-2xl">
              <div className="h-17 px-4 pt-4 text-sm text-placeholder">
                {DEFAULT_COMPOSER_PLACEHOLDER}
              </div>
              <div className="flex h-10 min-w-0 items-center px-2 pb-2">
                <span className="me-2 flex size-7 items-center justify-center text-muted-foreground">
                  <PaperclipIcon aria-hidden className="size-4 translate-y-px" />
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  {controls !== null ? (
                    <span
                      data-orbit-pending-composer-controls
                      className="flex min-w-0 items-center"
                      dangerouslySetInnerHTML={{ __html: controls }}
                    />
                  ) : null}
                  <span className="flex size-7 items-center justify-center text-muted-foreground">
                    <MicIcon aria-hidden className="size-4" />
                  </span>
                  <span className="flex size-8 items-center justify-center rounded-full bg-message-action text-message-action-foreground">
                    <ArrowUpIcon aria-hidden className="size-3.5" />
                  </span>
                </span>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
