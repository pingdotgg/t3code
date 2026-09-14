export type LoopbackAuthorizationStage = "dev" | "nightly" | "latest";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

function resolveLoopbackAuthorizationStage(): LoopbackAuthorizationStage {
  return typeof __T3CODE_BUILD_CHANNEL__ === "undefined" ? "dev" : __T3CODE_BUILD_CHANNEL__;
}

const stagePillLabels = {
  dev: "Dev",
  nightly: "Nightly",
  latest: null,
} as const satisfies Record<LoopbackAuthorizationStage, string | null>;

const wordmarkPath =
  "M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z";

export function renderLoopbackAuthorizationCompleteHtml(
  stage: LoopbackAuthorizationStage = resolveLoopbackAuthorizationStage(),
): string {
  const stagePill = stagePillLabels[stage];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>T3 Connect authorization complete</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        --background: #fafafa;
        --card: #ffffff;
        --border: rgba(23, 25, 31, 0.1);
        --foreground: #17191f;
        --muted-foreground: #6b7080;
        --pill: rgba(23, 25, 31, 0.06);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #101115;
          --card: #17181d;
          --border: rgba(255, 255, 255, 0.08);
          --foreground: #f1f3f7;
          --muted-foreground: #a3a8b4;
          --pill: rgba(255, 255, 255, 0.08);
        }
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 40px 16px;
        background: var(--background);
        color: var(--foreground);
        -webkit-font-smoothing: antialiased;
      }
      main {
        width: min(100%, 512px);
        padding: 24px;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: var(--card);
      }
      @media (min-width: 640px) {
        main { padding: 32px; }
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .wordmark {
        display: inline-flex;
        align-items: baseline;
        gap: 4px;
      }
      .wordmark svg {
        height: 10px;
        width: auto;
        color: var(--foreground);
      }
      .wordmark span {
        font-size: 14px;
        font-weight: 500;
        letter-spacing: -0.01em;
        color: var(--muted-foreground);
      }
      .pill {
        margin-left: 4px;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--pill);
        color: var(--muted-foreground);
        font-size: 10px;
        font-weight: 500;
        line-height: 16px;
      }
      h1 {
        margin: 24px 0 0;
        font-size: 20px;
        font-weight: 600;
        line-height: 1.25;
      }
      p {
        margin: 8px 0 0;
        color: var(--muted-foreground);
        font-size: 14px;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main data-stage="${stage}">
      <div class="brand">
        <span class="wordmark">
          <svg aria-label="T3" role="img" viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg"><path d="${wordmarkPath}" fill="currentColor" /></svg>
          <span>Code</span>
        </span>
        ${stagePill ? `<span class="pill">${stagePill}</span>` : ""}
      </div>
      <h1>You're connected</h1>
      <p>Return to your terminal to finish. You can close this window.</p>
    </main>
  </body>
</html>`;
}
