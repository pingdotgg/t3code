import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

import { useNextMessageSuggestion } from "./useNextMessageSuggestion";

type SuggestResult =
  | { _tag: "Success"; value: { suggestion: string } }
  | { _tag: "Failure"; cause: unknown };

const mocks = vi.hoisted(() => ({
  suggest: vi.fn<(request: unknown) => Promise<SuggestResult>>(),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    suggestNextMessage: { permissionAtom: () => Atom.make(true) },
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.suggest }));

const environmentId = EnvironmentId.make("environment-1");

function Suggestion(props: {
  readonly threadId: ThreadId;
  readonly afterMessageId: MessageId | null;
  readonly enabled?: boolean;
}) {
  const suggestion = useNextMessageSuggestion({
    environmentId,
    threadId: props.threadId,
    afterMessageId: props.afterMessageId,
    enabled: props.enabled ?? true,
  });
  return <p>{suggestion ?? "no suggestion"}</p>;
}

function deferred() {
  let resolve!: (suggestion: string) => void;
  const promise = new Promise<SuggestResult>((settle) => {
    resolve = (suggestion) => settle({ _tag: "Success", value: { suggestion } });
  });
  return { promise, resolve };
}

function setup() {
  mocks.suggest.mockReset();
}

describe("useNextMessageSuggestion", () => {
  it("asks once per agent reply and keeps the answer when the thread is shown again", async () => {
    setup();
    const threadId = ThreadId.make("thread-once");
    const reply = MessageId.make("reply-1");
    mocks.suggest.mockResolvedValue({ _tag: "Success", value: { suggestion: "Run the tests" } });

    {
      await using screen = await render(<Suggestion threadId={threadId} afterMessageId={reply} />);
      await expect.element(screen.getByText("Run the tests")).toBeVisible();
    }
    await using screen = await render(<Suggestion threadId={threadId} afterMessageId={reply} />);
    await expect.element(screen.getByText("Run the tests")).toBeVisible();

    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    expect(mocks.suggest).toHaveBeenCalledWith({
      environmentId,
      input: { threadId, afterMessageId: reply },
    });
  });

  it("drops an answer about an older reply", async () => {
    setup();
    const threadId = ThreadId.make("thread-stale");
    const first = deferred();
    const second = deferred();
    mocks.suggest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    await using screen = await render(
      <Suggestion threadId={threadId} afterMessageId={MessageId.make("reply-1")} />,
    );
    await screen.rerender(
      <Suggestion threadId={threadId} afterMessageId={MessageId.make("reply-2")} />,
    );
    await act(() => second.resolve("Answer the second reply"));
    await expect.element(screen.getByText("Answer the second reply")).toBeVisible();

    await act(() => first.resolve("Answer the first reply"));
    await expect.element(screen.getByText("Answer the second reply")).toBeVisible();
    expect(mocks.suggest).toHaveBeenCalledTimes(2);
  });

  it("stays quiet while off and before the agent replies", async () => {
    setup();
    mocks.suggest.mockResolvedValue({ _tag: "Success", value: { suggestion: "Run the tests" } });

    await using screen = await render(
      <Suggestion
        threadId={ThreadId.make("thread-off")}
        afterMessageId={MessageId.make("reply-1")}
        enabled={false}
      />,
    );
    await screen.rerender(
      <Suggestion threadId={ThreadId.make("thread-waiting")} afterMessageId={null} />,
    );
    await expect.element(screen.getByText("no suggestion")).toBeVisible();
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("does not ask again about a reply whose suggestion failed", async () => {
    setup();
    const threadId = ThreadId.make("thread-failing");
    const reply = MessageId.make("reply-1");
    mocks.suggest.mockResolvedValue({ _tag: "Failure", cause: "provider failed" });

    {
      await using _screen = await render(<Suggestion threadId={threadId} afterMessageId={reply} />);
      await vi.waitFor(() => expect(mocks.suggest).toHaveBeenCalledTimes(1));
    }
    await using screen = await render(<Suggestion threadId={threadId} afterMessageId={reply} />);
    await expect.element(screen.getByText("no suggestion")).toBeVisible();
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
  });
});
