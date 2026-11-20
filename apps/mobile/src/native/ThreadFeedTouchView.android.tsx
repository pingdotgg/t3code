import { requireNativeView, requireOptionalNativeModule } from "expo";
import { View, type ViewProps } from "react-native";

// Android exports a view prototype only for views with async functions, so the module reports it.
const NativeThreadFeedTouchView = requireOptionalNativeModule<{
  readonly hasThreadFeedTouchView?: () => boolean;
}>("T3NativeControls")?.hasThreadFeedTouchView?.()
  ? requireNativeView<ViewProps>("T3NativeControls", "ThreadFeedTouchView")
  : View;

/** Stops the feed's fling on touch and hands horizontal swipes near wide Markdown blocks to them. */
export function ThreadFeedTouchView(props: ViewProps) {
  return <NativeThreadFeedTouchView {...props} />;
}
