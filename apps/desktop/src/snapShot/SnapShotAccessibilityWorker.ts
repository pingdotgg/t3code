import {
  readAccessibleWindowContextWithApp,
  type SnapShotAccessibilityRequest,
} from "./SnapShotAccessibility.ts";

process.once("disconnect", () => process.exit(0));

async function readAccessibility() {
  const { App } = await import("@crowecawcaw/xa11y");
  process.send?.("ready");
  const request = await new Promise<SnapShotAccessibilityRequest>((resolve) => {
    process.once("message", resolve);
  });
  let started = false;
  const markStarted = () => {
    if (started) return;
    started = true;
    process.send?.("started");
  };
  const context = await readAccessibleWindowContextWithApp(App, request, markStarted).catch(
    () => undefined,
  );
  markStarted();
  process.send?.({ type: "result", context });
}

if (process.argv[2] === "read") {
  void readAccessibility().catch(() => process.send?.({ type: "result" }));
}
