import { useGT } from "gt-react-native";
import { useReviewHeaderPresentation as useSharedReviewHeaderPresentation } from "./useReviewHeaderPresentation.shared";

export function useReviewHeaderPresentation(
  props: Parameters<typeof useSharedReviewHeaderPresentation>[0],
): ReturnType<typeof useSharedReviewHeaderPresentation> {
  const gt = useGT();
  const presentation = useSharedReviewHeaderPresentation(props);
  return {
    ...presentation,
    title: props.title,
    subtitle: props.androidSubtitle || (props.title ? gt("Select a diff") : ""),
    menuIcon: "ellipsis.circle",
    refreshAction: {
      id: "refresh",
      title: gt("Refresh current diff"),
      disabled: !props.selectedSection || props.selectedSection.isLoading,
      onPress: () => {
        void props.onRefresh();
      },
    },
  };
}
