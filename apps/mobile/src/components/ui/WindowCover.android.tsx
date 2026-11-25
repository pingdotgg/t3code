import { Modal } from "react-native";

import type { WindowCoverProps } from "./WindowCover.types";

// Android takes the recents snapshot before JavaScript can render a cover; only FLAG_SECURE hides
// it, and that also blocks screenshots. A cover while backgrounded would only flash on return.
export function WindowCover(props: WindowCoverProps) {
  if (!props.visible) return null;
  return (
    <Modal visible animationType="none" statusBarTranslucent onRequestClose={() => {}}>
      {props.children}
    </Modal>
  );
}
