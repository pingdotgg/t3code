import { expect, it, vi } from "vite-plus/test";
import { createCatalogueRefreshQueue } from "./catalogueRefresh";
it("serializes refresh and coalesces receipts received while an installed generation loads", async () => {
  let finish!: () => void;
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const queue = createCatalogueRefreshQueue(refresh);
  const first = queue.request();
  const second = queue.request();
  const third = queue.request();
  expect(refresh).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second, third]);
  expect(refresh).toHaveBeenCalledTimes(2);
  await queue.request();
  expect(refresh).toHaveBeenCalledTimes(3);
});
it("does not start queued refresh work after environment disposal", async () => {
  let finish!: () => void;
  const refresh = vi.fn<() => Promise<void>>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const queue = createCatalogueRefreshQueue(refresh);
  const pending = queue.request();
  void queue.request();
  queue.dispose();
  finish();
  await pending;
  await queue.request();
  expect(refresh).toHaveBeenCalledTimes(1);
});
