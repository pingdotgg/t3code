import { EnvironmentId } from "@t3tools/contracts";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

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
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const root = createRoot(document.createElement("div"));
      try {
        act(() => root.render(<Composer {...props} />));
        act(() => target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] })));
        expect(pendingImports.get("draft")).toBe(1);
        if (change === "unmount") {
          act(() => root.unmount());
        } else {
          act(() =>
            root.render(
              <Composer
                {...props}
                expanded
                {...(change === "draft switch" ? { targetKey: "another-draft" } : {})}
                {...(change === "environment switch"
                  ? { environmentId: EnvironmentId.make("another-environment") }
                  : {})}
              />,
            ),
          );
          if (change !== "expand") {
            act(() => root.render(<Composer {...props} />));
          }
        }
        transcript.resolve(new File(["transcript"], "thread.txt"));
        await act(async () => importing);
        expect(attached).toEqual(change === "expand" ? ["thread.txt"] : []);
        expect(pendingImports.size).toBe(0);
        if (change === "expand") {
          act(() =>
            target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [] })),
          );
          await act(async () => importing);
          expect(expandedAtDrop).toEqual([false, true]);
          expect(attached).toEqual(["thread.txt", "thread.txt"]);
        }
      } finally {
        if (change !== "unmount") act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});
