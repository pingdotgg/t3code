export interface MobileComposerExpandOptions {
  cancelPendingRelease: () => void;
  primeExpandedState: () => void;
  focusEditorAtEnd: () => void;
  scheduleRelease: () => void;
}

export function expandMobileComposerForKeyboard(options: MobileComposerExpandOptions) {
  options.cancelPendingRelease();
  options.primeExpandedState();
  options.focusEditorAtEnd();
  options.scheduleRelease();
}
