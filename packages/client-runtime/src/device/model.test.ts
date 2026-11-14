import { expect, it, vi } from "vite-plus/test";
import { createDeviceModelSlot, type DeviceModelSource } from "./model.ts";

const pro: DeviceModelSource = { id: "iphone-18-pro", url: "/pro.glb" };
const max: DeviceModelSource = { id: "iphone-18-pro-max", url: "/max.glb" };

function fixture() {
  const pending: {
    signal: AbortSignal;
    resolve: (model: { dispose: () => void }) => void;
    reject: (error: Error) => void;
  }[] = [];
  const install = vi.fn();
  const load = vi.fn(
    (_source: DeviceModelSource, signal: AbortSignal) =>
      new Promise<{ dispose: () => void }>((resolve, reject) =>
        pending.push({ signal, resolve, reject }),
      ),
  );
  const slot = createDeviceModelSlot({ load, install });
  return { slot, pending, install, load };
}

it("cancels superseded downloads and releases a late decoded model without installing it", async () => {
  const { slot, pending, install, load } = fixture();
  slot.set(pro);
  slot.set({ ...pro });
  expect(load).toHaveBeenCalledTimes(1);
  slot.set(max);
  expect(pending[0]!.signal.aborted).toBe(true);
  const latest = { dispose: vi.fn() };
  const stale = { dispose: vi.fn() };
  pending[1]!.resolve(latest);
  await Promise.resolve();
  pending[0]!.resolve(stale);
  await Promise.resolve();
  expect(install).toHaveBeenCalledExactlyOnceWith(latest);
  expect(stale.dispose).toHaveBeenCalledOnce();
  slot.set(null);
  expect(install).toHaveBeenLastCalledWith(null);
  expect(latest.dispose).toHaveBeenCalledOnce();
  slot.dispose();
  expect(latest.dispose).toHaveBeenCalledOnce();
});

it("keeps the fallback on request failure and disposes results that finish after teardown", async () => {
  const { slot, pending, install } = fixture();
  slot.set(pro);
  pending[0]!.reject(new Error("offline"));
  await Promise.resolve();
  expect(install).not.toHaveBeenCalled();
  slot.set(max);
  slot.dispose();
  expect(pending[1]!.signal.aborted).toBe(true);
  const late = { dispose: vi.fn() };
  pending[1]!.resolve(late);
  await Promise.resolve();
  expect(late.dispose).toHaveBeenCalledOnce();
  expect(install).not.toHaveBeenCalled();
});

it("retries a failed source while ignoring rejection of a superseded request", async () => {
  const { slot, pending, install, load } = fixture();
  slot.set(pro);
  pending[0]!.reject(new Error("offline"));
  await Promise.resolve();
  slot.set({ ...pro });
  expect(load).toHaveBeenCalledTimes(2);
  slot.set(max);
  pending[1]!.reject(new Error("cancelled"));
  await Promise.resolve();
  slot.set({ ...max });
  expect(load).toHaveBeenCalledTimes(3);
  const recovered = { dispose: vi.fn() };
  pending[2]!.resolve(recovered);
  await Promise.resolve();
  expect(install).toHaveBeenCalledExactlyOnceWith(recovered);
  slot.dispose();
});

it("releases an invalid model and restores the fallback if scene preparation rejects it", async () => {
  const { slot, pending, install } = fixture();
  install.mockImplementationOnce(() => {
    throw new Error("invalid display");
  });
  slot.set(pro);
  const model = { dispose: vi.fn() };
  pending[0]!.resolve(model);
  await Promise.resolve();
  expect(model.dispose).toHaveBeenCalledOnce();
  expect(install).toHaveBeenLastCalledWith(null);
  slot.set({ ...pro });
  const recovered = { dispose: vi.fn() };
  pending[1]!.resolve(recovered);
  await Promise.resolve();
  expect(install).toHaveBeenLastCalledWith(recovered);
  slot.dispose();
});
