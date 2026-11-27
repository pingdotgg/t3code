import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useTimelineRewind } from "./useTimelineRewind";

const commands = vi.hoisted(() => ({
  fork: vi.fn(),
  waitForThreadShell: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => commands.fork,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  waitForThreadShell: commands.waitForThreadShell,
}));

const environmentId = EnvironmentId.make("test");
const sourceThreadId = ThreadId.make("source");
const sourceRef = scopeThreadRef(environmentId, sourceThreadId);
const sourcePath = "/test/source";
const runId = RunId.make("run");

function ForkButton({ start }: { start: (completion: Promise<void>) => void }) {
  const routeThreadKey = scopedThreadKey(sourceRef);
  const { onForkFromRunStable } = useTimelineRewind({
    environmentId,
    routeThreadRef: sourceRef,
    routeThreadKey,
    currentRouteThreadKeyRef: { current: routeThreadKey },
    serverProjection: null,
    activeThread: { id: sourceThreadId, title: "Source" } as EnvironmentThreadShell,
    timelineMessages: [],
    phase: "ready",
    isSendBusy: false,
    isRevertingCheckpoint: false,
    supportsConversationRollback: false,
    activeEnvironmentUnavailable: false,
    activeEnvironmentUnavailableLabel: null,
    promptRef: { current: "" },
    composerRef: { current: null },
    composerDraftTarget: sourceRef,
    setThreadError: () => undefined,
  });

  return (
    <button type="button" onClick={() => start(onForkFromRunStable({ sourceThreadId, runId }))}>
      Fork from this response
    </button>
  );
}

it.each([
  { paths: ["/test/other"], destination: "/test/other" },
  { paths: ["/test/other", sourcePath], destination: sourcePath },
  { paths: ["/settings"], destination: "/settings" },
  { paths: ["/usage"], destination: "/usage" },
])("keeps $destination open after the fork finishes", async ({ paths, destination }) => {
  const shellRequested = Promise.withResolvers<void>();
  const shellReady = Promise.withResolvers<boolean>();
  commands.fork.mockResolvedValue({ _tag: "Success" });
  commands.waitForThreadShell.mockImplementation(() => {
    shellRequested.resolve();
    return shellReady.promise;
  });

  const forkFinished = Promise.withResolvers<void>();
  await using screen = await render(<ForkButton start={forkFinished.resolve} />, {
    router: sourcePath,
  });
  const router = screen.router!;
  await screen.getByRole("button", { name: "Fork from this response" }).click();
  await shellRequested.promise;

  await act(async () => {
    for (const path of paths) {
      await router.navigate({ to: path });
    }
    shellReady.resolve(true);
    await forkFinished.promise;
  });

  expect(router.state.location.pathname).toBe(destination);
});
