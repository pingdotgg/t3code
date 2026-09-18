import { ScreenHeader } from "../../components/ScreenHeader";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ReviewSectionItem } from "./reviewModel";
import type { ReviewHeaderProps } from "./ReviewHeader.types";
import { useReviewHeaderPresentation } from "./useReviewHeaderPresentation";

export function ReviewHeader(props: ReviewHeaderProps) {
  const { panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const presentation = useReviewHeaderPresentation(props);
  const sectionAction = (
    section: ReviewSectionItem | null,
    title: string,
  ): ScreenHeaderMenuItem => ({
    id: section ? `section:${section.id}` : `unavailable:${title}`,
    title,
    disabled: section === null,
    selected: section !== null && section.id === props.selectedSection?.id,
    onPress: () => {
      if (section) props.onSelectSection(section.id);
    },
  });
  return (
    <ScreenHeader
      title={presentation.title}
      subtitle={presentation.subtitle}
      onBack={props.onReturnToThread}
      hideBottomBorder
      options={{ headerTintColor: props.iconColor, headerTitle: props.title }}
      backInSplitView={{ accessibilityLabel: "Back to chat", icon: "chevron.left" }}
      actions={
        props.showChangedFilesToggle
          ? [
              {
                accessibilityLabel: panes.auxiliaryPaneVisible
                  ? "Hide changed files"
                  : "Show changed files",
                icon: "sidebar.right",
                selected: panes.auxiliaryPaneVisible,
                onPress: toggleAuxiliaryPane,
              },
            ]
          : undefined
      }
      menus={[
        ...(presentation.gitMenu ? [presentation.gitMenu] : []),
        ...(props.showSectionToolbar
          ? [
              {
                title: "Select diff",
                icon: presentation.menuIcon,
                items: [
                  {
                    id: "sections",
                    inline: true,
                    items: [
                      sectionAction(props.sectionMenu.workingTree, "Working tree"),
                      sectionAction(props.sectionMenu.branchChanges, "Branch changes"),
                      sectionAction(props.sectionMenu.latestTurn, "Latest turn"),
                    ],
                  },
                  ...(props.sectionMenu.turns.length > 0
                    ? [
                        {
                          id: "turns",
                          title: "Turn",
                          items: props.sectionMenu.turns.map((section) => ({
                            id: `section:${section.id}`,
                            title: section.title,
                            subtitle: section.subtitle ?? undefined,
                            selected: section.id === props.selectedSection?.id,
                            onPress: () => props.onSelectSection(section.id),
                          })),
                        },
                      ]
                    : []),
                  ...(presentation.refreshAction ? [presentation.refreshAction] : []),
                ],
              },
            ]
          : []),
      ]}
    />
  );
}
