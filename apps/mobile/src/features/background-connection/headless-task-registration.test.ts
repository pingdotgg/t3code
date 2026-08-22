import { beforeEach, expect, it, vi } from "vite-plus/test";

const registerHeadlessTask = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  AppRegistry: { registerHeadlessTask },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

it("registers exactly one Android Headless JS task", async () => {
  const registration = await import("./headless-task-registration");

  registration.registerBackgroundConnectionHeadlessTask();
  registration.registerBackgroundConnectionHeadlessTask();

  expect(registerHeadlessTask).toHaveBeenCalledOnce();
  expect(registerHeadlessTask).toHaveBeenCalledWith(
    registration.BACKGROUND_CONNECTION_HEADLESS_TASK,
    expect.any(Function),
  );
});

it("finishes the native task when its dynamic import fails", async () => {
  const registration = await import("./headless-task-registration");
  const error = new Error("bundle chunk unavailable");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await expect(
    registration.runRegisteredBackgroundConnectionTask(() => Promise.reject(error)),
  ).resolves.toBeUndefined();

  expect(consoleError).toHaveBeenCalledWith(
    "[background-connection] registered headless task failed",
    error,
  );
  consoleError.mockRestore();
});
