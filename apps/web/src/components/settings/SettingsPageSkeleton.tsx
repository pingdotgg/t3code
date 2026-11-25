import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Skeleton } from "../ui/skeleton";

// Covers the previous page while the next one's code loads. It shows only after a beat, so a page
// that arrives quickly replaces the old one with no skeleton in between.
export function SettingsPageSkeleton() {
  return (
    <div
      aria-hidden
      data-settings-page-skeleton
      className="absolute inset-0 overflow-hidden bg-background transition-opacity delay-150 duration-0 starting:opacity-0"
    >
      <WorkspacePageContainer className="gap-8">
        <div className="space-y-2.5">
          <Skeleton shape="pill" className="h-3 w-28" />
          <Skeleton shape="card" className="h-48" />
        </div>
        <div className="space-y-2.5">
          <Skeleton shape="pill" className="h-3 w-20" />
          <Skeleton shape="card" className="h-32" />
        </div>
      </WorkspacePageContainer>
    </div>
  );
}
