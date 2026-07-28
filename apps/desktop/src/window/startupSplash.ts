export interface StartupSplashInput {
  readonly displayName: string;
  readonly shouldUseDarkColors: boolean;
  readonly message: string;
}

export const STARTUP_SPLASH_MESSAGE = "Starting local server…";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderStartupSplashHtml(input: StartupSplashInput): string {
  const background = input.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
  const foreground = input.shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const muted = input.shouldUseDarkColors ? "#94a3b8" : "#64748b";
  const track = input.shouldUseDarkColors ? "#1e293b" : "#e2e8f0";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
    <title>${escapeHtml(input.displayName)}</title>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
        background: ${background};
        color: ${foreground};
        font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
        -webkit-user-select: none;
        user-select: none;
      }
      body {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 14px;
        -webkit-app-region: drag;
      }
      .name {
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .message {
        font-size: 13px;
        color: ${muted};
      }
      .bar {
        width: 168px;
        height: 2px;
        border-radius: 999px;
        background: ${track};
        overflow: hidden;
      }
      .bar::after {
        content: "";
        display: block;
        width: 40%;
        height: 100%;
        border-radius: inherit;
        background: ${muted};
        animation: slide 1.2s ease-in-out infinite;
      }
      @keyframes slide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(250%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .bar::after {
          animation: none;
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <div class="name">${escapeHtml(input.displayName)}</div>
    <div class="message">${escapeHtml(input.message)}</div>
    <div class="bar"></div>
  </body>
</html>`;
}

export function toStartupSplashUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
