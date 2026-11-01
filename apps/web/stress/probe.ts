/**
 * Runs in the page before the app (Playwright init script). It records frame intervals, long
 * animation frames with their scripts, and React commits and component renders through the
 * DevTools hook, which production React also calls. Read the totals with `window.__stress`.
 */
export function installStressProbe(): void {
  interface Fiber {
    readonly type: unknown;
    readonly flags: number;
    readonly child: Fiber | null;
    readonly sibling: Fiber | null;
    readonly alternate: Fiber | null;
  }
  const PERFORMED_WORK = 1;
  const state = {
    recording: false,
    frames: [] as number[],
    longFrames: [] as Array<{
      start: number;
      duration: number;
      blocking: number;
      scripts: Array<{ source: string; invoker: string; duration: number }>;
    }>,
    commits: 0,
    renders: new Map<string, number>(),
    errors: [] as string[],
  };

  const nameOf = (fiber: Fiber): string | null => {
    const type = fiber.type as {
      displayName?: string;
      name?: string;
      render?: { displayName?: string; name?: string };
    } | null;
    if (typeof type === "function" || (typeof type === "object" && type !== null)) {
      return type.displayName ?? type.name ?? type.render?.displayName ?? type.render?.name ?? null;
    }
    return null;
  };
  // Skips subtrees React reused untouched, so only components that rendered are counted.
  const visit = (first: Fiber | null) => {
    for (let fiber = first; fiber; fiber = fiber.sibling) {
      const alternate = fiber.alternate;
      if (alternate && fiber.child === alternate.child && (fiber.flags & PERFORMED_WORK) === 0) {
        continue;
      }
      if (fiber.flags & PERFORMED_WORK && typeof fiber.type !== "string") {
        const name = nameOf(fiber);
        if (name) state.renders.set(name, (state.renders.get(name) ?? 0) + 1);
      }
      visit(fiber.child);
    }
  };
  Object.assign(window, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      checkDCE: () => {},
      onScheduleFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      onPostCommitFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
        if (!state.recording) return;
        state.commits += 1;
        visit(root.current.child);
      },
    },
  });

  let last = 0;
  const tick = (now: number) => {
    if (state.recording && last > 0) state.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  new PerformanceObserver((list) => {
    if (!state.recording) return;
    for (const entry of list.getEntries() as Array<
      PerformanceEntry & {
        blockingDuration?: number;
        scripts?: Array<{
          sourceURL: string;
          sourceFunctionName: string;
          invoker: string;
          duration: number;
        }>;
      }
    >) {
      state.longFrames.push({
        start: entry.startTime,
        duration: entry.duration,
        blocking: entry.blockingDuration ?? 0,
        scripts: (entry.scripts ?? []).map((script) => ({
          source: `${script.sourceFunctionName || "(anonymous)"} ${script.sourceURL.split("/").pop() ?? ""}`,
          invoker: script.invoker,
          duration: script.duration,
        })),
      });
    }
  }).observe({ type: "long-animation-frame", buffered: false });

  addEventListener("error", (event) => state.errors.push(String(event.message)));
  addEventListener("unhandledrejection", (event) => state.errors.push(String(event.reason)));

  Object.assign(window, {
    __stress: {
      start: () => {
        state.recording = true;
      },
      stop: () => {
        state.recording = false;
        return {
          frames: state.frames,
          longFrames: state.longFrames,
          commits: state.commits,
          renders: Object.fromEntries([...state.renders].sort((a, b) => b[1] - a[1])),
          errors: state.errors,
        };
      },
    },
  });
}
