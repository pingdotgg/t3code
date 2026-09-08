import { afterEach, expect, it, vi } from "vite-plus/test";

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

it("resumes once after a restart and retains the opt-in until setup is closed", async () => {
  storage();
  vi.resetModules();
  const before = await import("./snapShotSetupResume");
  expect(before.shouldResumeSnapShotSetupOnStartup()).toBe(false);
  before.saveSnapShotSetupResume(false);
  expect(before.shouldResumeSnapShotSetupOnStartup()).toBe(false);

  vi.resetModules();
  const after = await import("./snapShotSetupResume");
  expect(after.shouldResumeSnapShotSetupOnStartup()).toBe(true);
  expect(after.shouldResumeSnapShotSetupOnStartup()).toBe(false);
  expect(after.readSnapShotSetupResume()).toEqual({ wasEnabled: false });
  after.clearSnapShotSetupResume();

  vi.resetModules();
  const closed = await import("./snapShotSetupResume");
  expect(closed.shouldResumeSnapShotSetupOnStartup()).toBe(false);
});

it("does not interrupt setup when storage is unavailable", async () => {
  vi.stubGlobal("window", {});
  const resume = await import("./snapShotSetupResume");
  expect(() => resume.saveSnapShotSetupResume(true)).not.toThrow();
  expect(resume.readSnapShotSetupResume()).toBeNull();
  expect(() => resume.clearSnapShotSetupResume()).not.toThrow();
});
