import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { useEffect, useRef, type RefObject } from "react";
import { Alert } from "react-native";

export function useReviewCommentDismissal({
  commentText,
  attachmentCount,
  pendingImages,
  submitted,
  accepted,
}: {
  readonly commentText: string;
  readonly attachmentCount: number;
  /** In-flight image conversions, read live: state can lag a paste that precedes dismissal. */
  readonly pendingImages: RefObject<number>;
  readonly submitted: boolean;
  readonly accepted: RefObject<boolean>;
}) {
  const navigation = useNavigation();
  const confirmingDiscard = useRef(false);
  // Guard every dismissal until submission, not just the renders that already know about
  // content: a paste in the same frame as a back gesture must still reach this callback.
  usePreventRemove(!submitted, ({ data }) => {
    const empty = pendingImages.current === 0 && commentText.length === 0 && attachmentCount === 0;
    // The native removal guard can lag the successful synchronous transfer.
    if (accepted.current || empty) {
      navigation.dispatch(data.action);
      return;
    }
    if (pendingImages.current > 0 || confirmingDiscard.current) return;
    confirmingDiscard.current = true;
    Alert.alert(
      "Discard comment?",
      "Your comment and attachments have not been added to the draft.",
      [
        {
          text: "Keep editing",
          style: "cancel",
          onPress: () => {
            confirmingDiscard.current = false;
          },
        },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            confirmingDiscard.current = false;
            navigation.dispatch(data.action);
          },
        },
      ],
    );
  });
  useEffect(() => {
    if (!submitted) return;
    navigation.goBack();
  }, [navigation, submitted]);
}
