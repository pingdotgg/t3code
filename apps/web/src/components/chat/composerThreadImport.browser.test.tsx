import { EnvironmentId } from "@t3tools/contracts";
import { useRef } from "react";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../test/render";

import { importComposerThreadAttachment } from "./composerThreadImport";
import { THREAD_CONTEXT_DROP_EVENT, useThreadContextDrop } from "./threadContextDrag";

function deferredFile() {
  let resolve!: (file: File) => void;
  const promise = new Promise<File>((resolveFile) => {
    resolve = resolveFile;
  });
  return { promise, resolve };
}

describe("importComposerThreadAttachment from a thread drop", () => {
  it.each(["expand", "draft switch", "environment switch", "unmount"])(
    "keeps import ownership correct after %s while loading",
    async (change) => {
      const target = new EventTarget();
      const transcript = deferredFile();
      const pendingImports = new Map<string, number>();
      const attached: string[] = [];
      const expandedAtDrop: boolean[] = [];
      let importing!: Promise<void>;
      function Composer({
        environmentId,
        targetKey,
        expanded,
      }: {
        environmentId: EnvironmentId;
        targetKey: string;
        expanded: boolean;
      }) {
        const targetRef = useRef<EventTarget | null>(target);
        useThreadContextDrop(targetRef, environmentId, targetKey, (_refs, isActive) => {
          expandedAtDrop.push(expanded);
          importing = importComposerThreadAttachment({
            targetKey,
            pendingImports,
            countReservedAttachments: () => pendingImports.get(targetKey) ?? 0,
            load: () => transcript.promise,
            isActive,
            attach: async (file) => {
              attached.push(file.name);
              return true;
            },
            onLimitReached: () => {
              throw new Error("The slot should be available");
            },
          });
        });
        return null;
      }

      const props = {
        environmentId: EnvironmentId.make("destination"),
        targetKey: "draft",
        expanded: false,
      };
      await using screen = await render(<Composer {...props} />);
      await act(() =>
        target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] })),
      );
      expect(pendingImports.get("draft")).toBe(1);
      if (change === "unmount") {
        await screen.unmount();
      } else {
        await screen.rerender(
          <Composer
            {...props}
            expanded
            {...(change === "draft switch" ? { targetKey: "another-draft" } : {})}
            {...(change === "environment switch"
              ? { environmentId: EnvironmentId.make("another-environment") }
              : {})}
          />,
        );
        if (change !== "expand") {
          await screen.rerender(<Composer {...props} />);
        }
      }
      transcript.resolve(new File(["transcript"], "thread.txt"));
      await act(() => importing);
      expect(attached).toEqual(change === "expand" ? ["thread.txt"] : []);
      expect(pendingImports.size).toBe(0);
      if (change === "expand") {
        await act(() =>
          target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] })),
        );
        await act(() => importing);
        expect(expandedAtDrop).toEqual([false, true]);
        expect(attached).toEqual(["thread.txt", "thread.txt"]);
      }
    },
  );
});
