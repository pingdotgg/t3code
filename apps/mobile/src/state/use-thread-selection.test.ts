import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { threadDetailToShell } from "./use-thread-selection";

vi.mock("@react-navigation/native", () => ({}));
vi.mock("../lib/scopedEntities", () => ({}));
vi.mock("./entities", () => ({}));
vi.mock("./threads", () => ({}));
vi.mock("./pending-thread-creation", () => ({}));
vi.mock("./use-remote-environment-registry", () => ({}));
vi.mock("./use-thread-outbox", () => ({}));

it("retains an unreported model when a thread is opened before its shell arrives", () => {
  const thread = threadDetailToShell(EnvironmentId.make("test"), {
    ...v2Projection,
    thread: { ...v2Projection.thread, modelUnreported: true },
  });
  expect(thread.modelUnreported).toBe(true);
});
