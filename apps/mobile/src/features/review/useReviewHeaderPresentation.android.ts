import type { ReviewHeaderProps, ReviewHeaderPresentation } from "./ReviewHeader.types";

export function useReviewHeaderPresentation(props: ReviewHeaderProps): ReviewHeaderPresentation {
  return {
    title: "Review changes",
    subtitle: props.androidSubtitle || "Select a diff",
    gitMenu: null,
    menuIcon: "ellipsis.circle",
    refreshAction: {
      id: "refresh",
      title: "Refresh current diff",
      disabled: !props.selectedSection || props.selectedSection.isLoading,
      onPress: () => {
        void props.onRefresh();
      },
    },
  };
}
