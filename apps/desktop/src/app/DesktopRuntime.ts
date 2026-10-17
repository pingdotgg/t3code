import * as Runtime from "effect/Runtime";

// DesktopLifecycle owns signals and waits for backend shutdown before quitting
// Electron. NodeRuntime's competing signal handler interrupts that sequence.
export const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  fiber.addObserver((exit) => {
    teardown(exit, (code) => {
      if (code !== 0) process.exit(code);
    });
  });
});
