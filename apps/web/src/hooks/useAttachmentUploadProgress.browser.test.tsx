import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import type { AttachmentUploadState } from "../lib/attachmentUploadState";
import { useAttachmentUploadProgress } from "./useAttachmentUploadProgress";

function Probe({ id = "image", upload }: { id?: string; upload: AttachmentUploadState }) {
  const progress = useAttachmentUploadProgress(id, upload);
  return <output>{progress ?? "hidden"}</output>;
}

it("skips fast uploads and delays each attempt without delaying later progress or completion", async () => {
  const environmentId = EnvironmentId.make("environment");
  const uploading = (progress: number) => ({
    status: "uploading" as const,
    environmentId,
    progress,
  });
  const ready = { status: "ready" as const, environmentId, attachmentId: "attachment" };
  // The first render reads the clock to schedule the badge.
  using _timers = fakeTimers({ now: 0 });
  await using screen = await render(<Probe upload={uploading(0)} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(75));
  await screen.rerender(<Probe upload={ready} />);
  await act(() => vi.advanceTimersByTime(75));
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();

  await screen.rerender(<Probe upload={uploading(0)} />);
  await act(() => vi.advanceTimersByTime(149));
  await screen.rerender(<Probe upload={uploading(0.45)} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(1));
  await expect.element(screen.getByText("45%")).toBeInTheDocument();
  await screen.rerender(<Probe upload={uploading(0.7)} />);
  await expect.element(screen.getByText("70%")).toBeInTheDocument();
  await screen.rerender(<Probe upload={ready} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();

  await screen.rerender(<Probe upload={uploading(0)} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(150));
  await expect.element(screen.getByText("0%")).toBeInTheDocument();
  await screen.rerender(<Probe id="another-image" upload={uploading(0)} />);
  await expect.element(screen.getByText("hidden")).toBeInTheDocument();
});
