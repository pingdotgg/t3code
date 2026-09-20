import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ accepted: { current: false }, setSubmitted: vi.fn() }));
vi.mock("react", () => ({
  useRef: () => state.accepted,
  useState: () => [false, state.setSubmitted],
  useCallback: (callback: () => unknown) => callback,
}));
import { useReviewCommentSubmission } from "./useReviewCommentSubmission";

beforeEach(() => {
  state.accepted.current = false;
  vi.clearAllMocks();
});
describe("review comment submission", () => {
  it("transfers exactly once when pressed twice before a rerender", () => {
    const { submit } = useReviewCommentSubmission();
    const transfer = vi.fn(() => true);
    submit(transfer);
    submit(transfer);
    expect(transfer).toHaveBeenCalledOnce();
    expect(state.setSubmitted).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("keeps failure editable and permits a successful retry", () => {
    const { submit } = useReviewCommentSubmission();
    const transfer = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    submit(transfer);
    expect(state.setSubmitted).not.toHaveBeenCalled();
    submit(transfer);
    expect(transfer).toHaveBeenCalledTimes(2);
    expect(state.setSubmitted).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("unlocks after a thrown transfer without marking the input submitted", () => {
    const { submit } = useReviewCommentSubmission();
    expect(() =>
      submit(() => {
        throw new Error("Transfer failed");
      }),
    ).toThrow("Transfer failed");
    expect(state.setSubmitted).not.toHaveBeenCalled();
    submit(() => true);
    expect(state.setSubmitted).toHaveBeenCalledExactlyOnceWith(true);
  });
});
