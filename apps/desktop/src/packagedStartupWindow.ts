export interface PackagedStartupWindow {
  readonly isDestroyed: () => boolean;
  readonly loadURL: (url: string) => Promise<void>;
}

export function createPackagedStartupLoadingUrl(appName: string): string {
  const escapedAppName = appName
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="dark light" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedAppName}</title>
    <style>
      :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111; color: #f5f5f5; }
      main { display: grid; justify-items: center; gap: 18px; }
      .spinner { width: 28px; height: 28px; border: 3px solid #ffffff24; border-top-color: #fff; border-radius: 50%; animation: spin .8s linear infinite; }
      p { margin: 0; color: #ffffffa8; font-size: 14px; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; border-top-color: #ffffff80; } }
    </style>
  </head>
  <body>
    <main aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <p>Starting ${escapedAppName}</p>
    </main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export async function navigatePackagedStartupWindow(
  window: PackagedStartupWindow,
  backendUrl: string,
): Promise<void> {
  if (window.isDestroyed()) {
    return;
  }
  await window.loadURL(backendUrl);
}
