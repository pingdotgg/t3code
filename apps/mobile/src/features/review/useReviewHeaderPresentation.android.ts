import { useReviewHeaderPresentation as useSharedReviewHeaderPresentation } from "./useReviewHeaderPresentation.shared";

export function useReviewHeaderPresentation(
  props: Parameters<typeof useSharedReviewHeaderPresentation>[0],
): ReturnType<typeof useSharedReviewHeaderPresentation> {
  const presentation = useSharedReviewHeaderPresentation(props);
  return {
    ...presentation,
    title: props.title,
    subtitle: props.androidSubtitle || (props.title ? "Select a diff" : ""),
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
