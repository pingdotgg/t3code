import { useEffect, useRef, useState, type RefObject } from "react";
import {
  Keyboard,
  Platform,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type TextInputInstance,
} from "react-native";

// Room left between the focused field and the keyboard.
const REVEAL_MARGIN = 16;

type KeyboardSession = {
  // Window y of the keyboard's top edge while it is up, else null.
  keyboardTop: number | null;
  // The scroll offset from before the keyboard came up, restored when it goes.
  restOffsetY: number | null;
  // Set once one of this form's fields had focus while the keyboard was up.
  engaged: boolean;
  focusedInput: TextInputInstance | null;
  offsetY: number;
};

type ScrollViewRef = RefObject<ScrollViewInstance | null>;

// Pads the form by the part of it the keyboard covers and scrolls the focused field above it.
function reveal(
  scrollRef: ScrollViewRef,
  session: KeyboardSession,
  setKeyboardInset: (inset: number) => void,
) {
  const keyboardTop = session.keyboardTop;
  const input = session.focusedInput;
  const scrollView = scrollRef.current?.getNativeScrollRef();
  if (keyboardTop === null || !input || !scrollView) return;
  session.engaged = true;
  scrollView.measureInWindow((_x, y, _width, height) => {
    setKeyboardInset(Math.max(0, y + height - keyboardTop));
  });
  input.measureInWindow((_x, y, _width, height) => {
    const covered = y + height + REVEAL_MARGIN - keyboardTop;
    if (covered <= 0) return;
    scrollRef.current?.scrollTo({ y: session.offsetY + covered, animated: true });
  });
}

/**
 * Keeps the focused pairing field above the iOS keyboard and restores the pre-keyboard offset.
 * Not `automaticallyAdjustKeyboardInsets`: RN's handler clamps the form's negative resting offset
 * (automatic insets under the header) to 0 on every keyboard frame change, hiding the scan card.
 * The ScrollView needs `scrollToOverflowEnabled` so `scrollTo` can reach that negative offset.
 */
export function usePairingFormKeyboard() {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const session = useRef<KeyboardSession>({
    keyboardTop: null,
    restOffsetY: null,
    engaged: false,
    focusedInput: null,
    offsetY: 0,
  });
  const [keyboardInset, setKeyboardInset] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the native keyboard while mounted
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (event) => {
      const current = session.current;
      // Nothing has scrolled the form for this keyboard yet, so this is where it rests.
      if (current.keyboardTop === null) current.restOffsetY = current.offsetY;
      current.keyboardTop = event.endCoordinates.screenY;
      reveal(scrollRef, current, setKeyboardInset);
    });
    const hide = Keyboard.addListener("keyboardWillHide", () => {
      const current = session.current;
      if (current.engaged) {
        setKeyboardInset(0);
        if (current.restOffsetY !== null && current.restOffsetY !== current.offsetY) {
          scrollRef.current?.scrollTo({ y: current.restOffsetY, animated: true });
        }
      }
      current.keyboardTop = null;
      current.restOffsetY = null;
      current.engaged = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return {
    scrollRef,
    keyboardInset,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      session.current.offsetY = event.nativeEvent.contentOffset.y;
    },
    onInputFocus: (input: TextInputInstance | null) => {
      session.current.focusedInput = input;
      reveal(scrollRef, session.current, setKeyboardInset);
    },
    onInputBlur: (input: TextInputInstance | null) => {
      if (session.current.focusedInput === input) session.current.focusedInput = null;
    },
  };
}
