export type AndroidKeyboardRecoveryState = "ready" | "quarantined";

export type AndroidKeyboardRecoveryEvent = "resume" | "keyboard-show" | "input-focus";

export function getInitialAndroidKeyboardRecoveryState(input: {
  readonly isAndroid: boolean;
  readonly isAppActive: boolean;
}): AndroidKeyboardRecoveryState {
  return input.isAndroid && input.isAppActive ? "quarantined" : "ready";
}

export function reduceAndroidKeyboardRecovery(
  state: AndroidKeyboardRecoveryState,
  event: AndroidKeyboardRecoveryEvent,
): AndroidKeyboardRecoveryState {
  if (event === "resume") {
    return "quarantined";
  }

  return "ready";
}

export function isAndroidKeyboardAnimationUsable(input: {
  readonly isKeyboardVisible: boolean;
  readonly isQuarantined: boolean;
}): boolean {
  return input.isKeyboardVisible && !input.isQuarantined;
}
