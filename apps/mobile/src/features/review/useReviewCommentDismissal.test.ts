import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { NavigationAction } from "@react-navigation/native";
import type { AlertButton } from "react-native";

const harness = vi.hoisted(() => ({
  prevented: false,
  onRemove: (_event: { data: { action: NavigationAction } }) => {},
  confirmation: { current: false },
  effects: [] as Array<() => unknown>,
  buttons: [] as AlertButton[],
  dispatch: vi.fn(),
  goBack: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("react", () => ({
  useRef: () => harness.confirmation,
  useEffect: (effect: () => unknown) => harness.effects.push(effect),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: harness.dispatch, goBack: harness.goBack }),
  usePreventRemove: (prevented: boolean, callback: typeof harness.onRemove) => {
    harness.prevented = prevented;
    harness.onRemove = callback;
  },
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (...args: [string, string, AlertButton[]]) => {
      harness.alert(...args);
      harness.buttons = args[2];
    },
  },
}));

import { useReviewCommentDismissal } from "./useReviewCommentDismissal";

function render(overrides: Partial<Parameters<typeof useReviewCommentDismissal>[0]> = {}) {
  useReviewCommentDismissal({
    commentText: "",
    attachmentCount: 0,
    pendingImages: 0,
    submitted: false,
    accepted: { current: false },
    ...overrides,
  });
}
const action: NavigationAction = { type: "GO_BACK", source: "review-editor" };
function remove() {
  if (harness.prevented) harness.onRemove({ data: { action } });
}
function choose(text: string) {
  harness.buttons.find((button) => button.text === text)?.onPress?.();
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.confirmation.current = false;
  harness.buttons = [];
  harness.effects = [];
});

describe("review comment removal boundary", () => {
  it("allows an empty editor to leave without confirmation", () => {
    render();
    remove();
    expect(harness.prevented).toBe(false);
    expect(harness.alert).not.toHaveBeenCalled();
  });
  it.each([{ commentText: "Unsent" }, { attachmentCount: 1 }])(
    "protects invested input %j",
    (input) => {
      render(input);
      remove();
      remove();
      expect(harness.prevented).toBe(true);
      expect(harness.alert).toHaveBeenCalledTimes(1);
      choose("Keep editing");
      expect(harness.dispatch).not.toHaveBeenCalled();
      remove();
      expect(harness.alert).toHaveBeenCalledTimes(2);
      choose("Discard");
      expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith(action);
    },
  );
  it("keeps the sheet protected after a failed transfer", () => {
    render({ commentText: "Unsent", attachmentCount: 1, submitted: false });
    remove();
    expect(harness.prevented).toBe(true);
    expect(harness.alert).toHaveBeenCalledOnce();
    expect(harness.goBack).not.toHaveBeenCalled();
  });
  it("blocks removal while selected images are still being prepared", () => {
    render({ pendingImages: 1 });
    remove();
    expect(harness.prevented).toBe(true);
    expect(harness.alert).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
  });
  it("unlocks successful transfer without a discard prompt", () => {
    render({ commentText: "Transferred", attachmentCount: 1, submitted: true });
    harness.effects.forEach((effect) => effect());
    expect(harness.goBack).toHaveBeenCalledOnce();
    remove();
    expect(harness.prevented).toBe(false);
    expect(harness.alert).not.toHaveBeenCalled();
  });
});

it("allows removal immediately after transfer, before the guard's render catches up", () => {
  const accepted = { current: false };
  render({ commentText: "Transferred", accepted });
  expect(harness.prevented).toBe(true);
  accepted.current = true;
  remove();
  expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith(action);
  expect(harness.alert).not.toHaveBeenCalled();
});
