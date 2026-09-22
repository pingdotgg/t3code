import { useCallback, useRef, useState } from "react";

/** A synchronous transfer can be tapped twice before React commits the disabled button. */
export function useReviewCommentSubmission() {
  const accepted = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  const submit = useCallback((transfer: () => boolean) => {
    if (accepted.current) return;
    accepted.current = true;
    try {
      if (transfer()) setSubmitted(true);
      else accepted.current = false;
    } catch (error) {
      accepted.current = false;
      throw error;
    }
  }, []);
  return { submitted, submit, accepted };
}
