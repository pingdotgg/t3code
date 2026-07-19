export function renderLoopbackAuthorizationCompleteHtml(): string {
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
        background: linear-gradient(145deg, #5ab8fa 0%, #347ff8 46%, #1939bd 100%);
      }
      .stage::before {
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
      .status {
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        margin-top: -52px;
        margin-bottom: 22px;
        border: 4px solid white;
        border-radius: 50%;
        background: #2065df;
        color: white;
        font-size: 22px;
        font-weight: 700;
        box-shadow: 0 8px 22px rgba(25, 72, 177, 0.3);
      }
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
      .next {
        margin-top: 24px;
        padding: 14px 16px;
        border: 1px solid rgba(23, 25, 31, 0.1);
        border-radius: 12px;
        background: #f7f8fa;
        color: #454a55;
        font-size: 13px;
      }
      .next strong { color: #17191f; }
      @media (prefers-color-scheme: dark) {
        :root { background: #101115; color: #f1f3f7; }
        body { background: radial-gradient(48rem 22rem at 50% -8rem, rgba(55, 102, 210, 0.2), transparent), #101115; }
        main { border-color: rgba(255, 255, 255, 0.1); background: rgba(25, 27, 33, 0.96); }
        .status { border-color: #191b21; }
        .eyebrow { color: #77a8ff; }
        .description { color: #a8adb8; }
        .next { border-color: rgba(255, 255, 255, 0.1); background: #20232a; color: #b9bec8; }
        .next strong { color: #f1f3f7; }
      }
    </style>
  </head>
  <body>
    <main>
      <header class="stage">
        <div class="stage-content">
          <p class="brand">T3 Code</p>
        </div>
      </header>
      <section class="content">
        <div class="status" aria-hidden="true">✓</div>
        <p class="eyebrow">Browser authorization complete</p>
        <h1>You're connected</h1>
        <p class="description">The authorization code was delivered securely to your waiting terminal.</p>
        <div class="next"><strong>Next:</strong> return to the terminal to finish T3 Connect setup. You can close this window.</div>
      </section>
    </main>
  </body>
</html>`;
}
