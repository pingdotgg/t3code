import { createContext, type ReactNode, useMemo } from "react";

import { type ReviewHighlighterState, useReviewHighlighterState } from "./reviewHighlighterState";

const ReviewHighlighterContext = createContext<ReviewHighlighterState>({
  engine: null,
  error: null,
  status: "idle",
});

export function ReviewHighlighterProvider(props: { readonly children: ReactNode }) {
  const value = useReviewHighlighterState();
  const contextValue = useMemo(() => value, [value]);

  return (
    <ReviewHighlighterContext.Provider value={contextValue}>
      {props.children}
    </ReviewHighlighterContext.Provider>
  );
}
