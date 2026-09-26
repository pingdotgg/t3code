import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

import { ReleaseNotesPanel } from "../ReleaseNotesPanel";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export function SidebarUpdateReleaseNotes({
  shell,
  state,
  tooltip,
}: {
  readonly shell: DesktopUpdateShell | undefined;
  readonly state: DesktopUpdateState;
  readonly tooltip: string;
}) {
  if (state.channel !== "nightly" || state.releaseNotes.length === 0) {
    return <>{tooltip}</>;
  }

  return (
    <ReleaseNotesPanel
      header={
        state.status === "available" ? (
          <div>
            <div className="whitespace-nowrap text-sm leading-5 font-medium">
              Update ready to download
            </div>
            {state.availableVersion ? (
              <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                {state.availableVersion}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm leading-5 font-medium">{tooltip}</div>
        )
      }
      omittedReleaseCount={state.omittedReleaseCount}
      releaseNotes={state.releaseNotes}
      shell={shell}
    />
  );
}
