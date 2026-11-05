import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { useThreadReferenceHighlight } from "./threadReferenceHighlight";

it("keeps a clicked thread highlighted after hover ends", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-b"),
  };
  const highlight = useThreadReferenceHighlight;

  highlight.getState().enter(target);
  highlight.getState().togglePinned(target);
  highlight.getState().leave(target);
  expect(highlight.getState().pinned).toEqual(target);

  highlight.getState().enter(other);
  expect(highlight.getState().hovered).toEqual(other);
  highlight.getState().leave(other);
  expect(highlight.getState().pinned).toEqual(target);

  highlight.getState().togglePinned(target);
  expect(highlight.getState().pinned).toBeNull();
});
