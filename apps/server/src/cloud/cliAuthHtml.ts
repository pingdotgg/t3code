export type LoopbackAuthorizationStage = "dev" | "nightly" | "latest";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

function resolveLoopbackAuthorizationStage(): LoopbackAuthorizationStage {
  return typeof __T3CODE_BUILD_CHANNEL__ === "undefined" ? "dev" : __T3CODE_BUILD_CHANNEL__;
}

const stageBrands = {
  dev: "T3 Code (Dev)",
  nightly: "T3 Code (Nightly)",
  latest: "T3 Code",
} as const satisfies Record<LoopbackAuthorizationStage, string>;

export function renderLoopbackAuthorizationCompleteHtml(
  stage: LoopbackAuthorizationStage = resolveLoopbackAuthorizationStage(),
): string {
  const stageBrand = stageBrands[stage];

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>T3 Connect authorization complete</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; color: #252525; }
      * { box-sizing: border-box; }
      body { min-height: 100svh; margin: 0; display: grid; place-items: center; padding: 32px 16px; }
      main { width: min(100%, 576px); padding: 32px; border: 1px solid #dedede; border-radius: 16px; background: #f8f8f8; box-shadow: 0 4px 16px #0000000a; }
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; }
      .brand { display: flex; align-items: baseline; gap: 6px; font-size: 18px; font-weight: 500; }
      .brand svg { width: auto; height: 12px; }
      .stage { padding: 2px 6px; border: 1px solid #dedede; border-radius: 6px; font-size: 12px; color: #636363; }
      h1 { margin: 0; font-size: clamp(26px, 5vw, 34px); line-height: 1.3; font-weight: 600; }
      .description { margin: 8px 0 0; color: #636363; font-size: 15px; line-height: 1.5; }
      @media (prefers-color-scheme: dark) {
        :root { background: #151515; color: #d4d4d4; }
        main { background: #191919; border-color: #333; box-shadow: 0 4px 16px #0003; }
        .stage { border-color: #333; }
        .stage, .description { color: #8a8a8a; }
      }
    </style>
  </head>
  <body>
    <main>
      <header data-stage="${stage}">
        <span class="brand" role="img" aria-label="${stageBrand}"><svg aria-hidden="true" viewBox="15.5309 37 94.3941 56.96" xmlns="http://www.w3.org/2000/svg"><path d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z" fill="currentColor" /></svg>Code</span>
        ${stage === "latest" ? "" : `<span class="stage" aria-hidden="true">${stage === "dev" ? "Dev" : "Nightly"}</span>`}
      </header>
      <section>
        <h1>You're connected</h1>
        <p class="description">Return to your terminal to finish setting up T3 Connect. You can close this window.</p>
      </section>
    </main>
  </body>
</html>`;
}
