/**
 * The marketing site embeds the demo with an optional `?stage=` query param so
 * visitors can preview the per-channel builds (Latest / Nightly / Dev). The
 * stage only changes the version string the mock server reports — the real
 * branding + sidebar stage art logic reacts to it exactly like production.
 *
 * The embedding page can also switch the stage live (no iframe reload) by
 * posting `{ type: "t3-demo-stage", stage }` to the demo window; the mock
 * server re-emits its config stream so the app reacts like a real server
 * version change.
 */
export type DemoStage = "latest" | "nightly" | "dev";

function isDemoStage(value: unknown): value is DemoStage {
  return value === "latest" || value === "nightly" || value === "dev";
}

function initialDemoStage(): DemoStage {
  if (typeof window === "undefined") return "latest";
  const stage = new URLSearchParams(window.location.search).get("stage");
  return isDemoStage(stage) ? stage : "latest";
}

let currentStage: DemoStage = initialDemoStage();
const stageListeners = new Set<(stage: DemoStage) => void>();

export function resolveDemoStage(): DemoStage {
  return currentStage;
}

export function setDemoStage(stage: DemoStage): void {
  if (stage === currentStage) return;
  currentStage = stage;
  for (const listener of stageListeners) listener(stage);
}

export function onDemoStageChange(listener: (stage: DemoStage) => void): () => void {
  stageListeners.add(listener);
  return () => stageListeners.delete(listener);
}

/** Lets the embedding marketing page switch the previewed channel live. */
export function installDemoStageBridge(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    if (!("type" in data) || data.type !== "t3-demo-stage") return;
    if (!("stage" in data) || !isDemoStage(data.stage)) return;
    if (
      "transitionDurationMs" in data &&
      typeof data.transitionDurationMs === "number" &&
      Number.isFinite(data.transitionDurationMs)
    ) {
      const durationMs = Math.min(2_000, Math.max(0, data.transitionDurationMs));
      document.documentElement.style.setProperty(
        "--demo-stage-transition-duration",
        `${durationMs}ms`,
      );
    }
    setDemoStage(data.stage);
  });
}

export function demoServerVersionFor(baseVersion: string, stage: DemoStage): string {
  if (stage === "nightly") return `${baseVersion}-nightly.20260701.1`;
  if (stage === "dev") return `${baseVersion}-dev.1`;
  return baseVersion;
}

export function demoServerVersion(baseVersion: string): string {
  return demoServerVersionFor(baseVersion, resolveDemoStage());
}
