import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReviewSectionMenu } from "./review-section-menu";
import type { ReviewSectionItem } from "./reviewModel";
import type { ScreenHeaderMenuItem, ScreenHeaderMenu } from "../../components/ScreenHeader.types";
import type { AppSymbolName } from "../../components/AppSymbol";

export interface ReviewHeaderPresentation {
  readonly title: string;
  readonly subtitle: string;
  readonly gitMenu: ScreenHeaderMenu | null;
  readonly menuIcon: AppSymbolName;
  readonly refreshAction?: ScreenHeaderMenuItem;
}

export interface ReviewHeaderProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly subtitle: string;
  readonly androidSubtitle: string;
  readonly iconColor: string;
  readonly selectedThreadCwd: string | null;
  readonly sectionMenu: ReviewSectionMenu;
  readonly selectedSection: ReviewSectionItem | null;
  readonly showSectionToolbar: boolean;
  readonly showChangedFilesToggle: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly onSelectSection: (sectionId: string) => void;
  readonly onReturnToThread: () => void;
}
