import { ReviewHighlighterProvider } from "../../../../features/review/ReviewHighlighterProvider";
import { ReviewSheet } from "../../../../features/review/ReviewSheet";

export default function ReviewRoute() {
  return (
    <ReviewHighlighterProvider>
      <ReviewSheet />
    </ReviewHighlighterProvider>
  );
}
