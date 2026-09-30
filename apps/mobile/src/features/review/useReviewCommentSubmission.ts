import { useCallback, useRef, useState, type RefObject } from "react";

/** A synchronous transfer can be tapped twice before React commits the disabled button. */
export function useReviewCommentSubmission(pendingImages: RefObject<number>) {
  const accepted = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const submit = useCallback(
    (transfer: () => boolean) => {
      if (accepted.current || pendingImages.current > 0) return;
      accepted.current = true;
      try {
        if (transfer()) setSubmitted(true);
        else accepted.current = false;
      } catch (error) {
        accepted.current = false;
        throw error;
      }
    },
    [pendingImages],
  );
  return { submitted, submit, accepted };
}
