const DEFAULT_LINEAR_INSTALL_SCOPES = "read,write,comments:create,app:mentionable";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildLinearOAuthCallbackUrl(origin: string) {
  const normalizedOrigin = origin.replace(/\/$/, "");
  return `${normalizedOrigin}/linear/oauth/callback`;
}

export function buildLinearInstallUrl(origin: string) {
  const clientId = process.env.LINEAR_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("Missing required Linear environment variable: LINEAR_CLIENT_ID");
  }

  const scope = process.env.LINEAR_INSTALL_SCOPES?.trim() ?? DEFAULT_LINEAR_INSTALL_SCOPES;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: buildLinearOAuthCallbackUrl(origin),
    response_type: "code",
    scope,
    actor: "app",
  });
  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

export function renderLinearOAuthPage(input: {
  readonly detail: string;
  readonly status: "error" | "success";
  readonly title: string;
}) {
  const statusCode = input.status === "success" ? 200 : 500;
  const accent = input.status === "success" ? "#166534" : "#991b1b";
  const background = input.status === "success" ? "#f0fdf4" : "#fef2f2";

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      :root {
        color-scheme: light;
        font-family:
          "SF Pro Text",
          "Helvetica Neue",
          sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
        color: #0f172a;
      }

      main {
        max-width: 40rem;
        margin: 2rem;
        padding: 2rem;
        border-radius: 1.25rem;
        border: 1px solid rgba(15, 23, 42, 0.08);
        background: white;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.12);
      }

      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
      }

      p {
        margin: 0;
        line-height: 1.6;
      }

      .status {
        display: inline-flex;
        margin-bottom: 1rem;
        padding: 0.35rem 0.7rem;
        border-radius: 999px;
        background: ${background};
        color: ${accent};
        font-weight: 600;
        letter-spacing: 0.01em;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="status">${escapeHtml(input.status.toUpperCase())}</div>
      <h1>${escapeHtml(input.title)}</h1>
      <p>${escapeHtml(input.detail)}</p>
    </main>
  </body>
</html>`,
    {
      status: statusCode,
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    },
  );
}
