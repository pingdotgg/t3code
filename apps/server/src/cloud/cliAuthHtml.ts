export type LoopbackAuthorizationStage = "dev" | "nightly" | "latest";

declare const __T3CODE_BUILD_CHANNEL__: "nightly" | "latest" | undefined;

export function resolveLoopbackAuthorizationStage(): LoopbackAuthorizationStage {
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
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f9;
        color: #17191f;
      }
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        padding: 32px 16px;
        background:
          radial-gradient(48rem 22rem at 50% -8rem, rgba(47, 119, 235, 0.15), transparent),
          #f6f7f9;
      }
      main {
        width: min(100%, 576px);
        overflow: hidden;
        border: 1px solid rgba(23, 25, 31, 0.1);
        border-radius: 20px;
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 64px rgba(16, 24, 40, 0.16);
      }
      .stage {
        position: relative;
        height: 96px;
        overflow: hidden;
        padding: 22px 24px;
        color: white;
      }
      .stage-latest {
        background:
          radial-gradient(circle at 76% 18%, rgba(136, 204, 255, 0.52), transparent 38%),
          linear-gradient(135deg, #2468df, #172f82);
      }
      .stage-dev {
        background: linear-gradient(145deg, #5ab8fa 0%, #347ff8 46%, #1939bd 100%);
      }
      .stage-dev::before {
        content: "";
        position: absolute;
        inset: 0;
        opacity: 0.42;
        background-image:
          linear-gradient(rgba(234, 246, 255, 0.25) 1px, transparent 1px),
          linear-gradient(90deg, rgba(234, 246, 255, 0.25) 1px, transparent 1px),
          linear-gradient(rgba(234, 246, 255, 0.12) 1px, transparent 1px),
          linear-gradient(90deg, rgba(234, 246, 255, 0.12) 1px, transparent 1px);
        background-size: 32px 32px, 32px 32px, 8px 8px, 8px 8px;
      }
      .stage-nightly {
        background:
          radial-gradient(22rem 8rem at 78% 18%, rgba(81, 101, 216, 0.42), transparent 58%),
          linear-gradient(145deg, #07152f 0%, #151443 52%, #32155b 100%);
      }
      .stage-nightly::before {
        content: "";
        position: absolute;
        inset: 0;
        opacity: 0.78;
        background-image:
          radial-gradient(circle at 12px 12px, rgba(228, 234, 255, 0.9) 0 1px, transparent 1.5px),
          radial-gradient(circle at 38px 28px, rgba(228, 234, 255, 0.58) 0 0.8px, transparent 1.3px),
          radial-gradient(circle at 58px 9px, rgba(200, 215, 255, 0.72) 0 0.9px, transparent 1.4px);
        background-size: 72px 48px, 96px 64px, 128px 56px;
      }
      .stage::after {
        content: "";
        position: absolute;
        inset: 0;
        background:
          radial-gradient(circle at 78% 20%, rgba(210, 255, 255, 0.36), transparent 34%),
          linear-gradient(to bottom, transparent 24%, rgba(8, 28, 89, 0.38));
      }
      .stage-content {
        position: relative;
        z-index: 1;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand {
        margin: 0;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.2em;
        text-transform: uppercase;
      }
      .brand { color: rgba(255, 255, 255, 0.82); }
      .content { padding: 30px 32px 34px; }
      .eyebrow {
        margin: 0 0 8px;
        color: #2866cc;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(26px, 5vw, 34px); line-height: 1.12; letter-spacing: -0.035em; }
      .description { margin: 12px 0 0; color: #646975; font-size: 15px; line-height: 1.6; }
      @media (prefers-color-scheme: dark) {
        :root { background: #101115; color: #f1f3f7; }
        body { background: radial-gradient(48rem 22rem at 50% -8rem, rgba(55, 102, 210, 0.2), transparent), #101115; }
        main { border-color: rgba(255, 255, 255, 0.1); background: rgba(25, 27, 33, 0.96); }
        .eyebrow { color: #77a8ff; }
        .description { color: #a8adb8; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="stage stage-${stage}" data-stage="${stage}">
        <div class="stage-content">
          <p class="brand">${stageBrand}</p>
        </div>
      </header>
      <section class="content">
        <p class="eyebrow">Browser authorization complete</p>
        <h1>You're connected</h1>
        <p class="description">Return to your terminal to finish setting up T3 Connect. You can close this window.</p>
      </section>
    </main>
  </body>
</html>`;
}
