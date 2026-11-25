interface Env {
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  CDN_ORIGIN: string;
  GITHUB_TOKEN?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-None-Match, If-Modified-Since",
};

function withCors(headers: Headers): Headers {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function jsonResponse(body: unknown, status = 200, cacheControl = "public, max-age=60"): Response {
  const headers = withCors(
    new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

function rewriteReleaseAssetUrls(payload: unknown, repo: string, cdnOrigin: string): unknown {
  const prefix = `https://github.com/${repo}/releases/download/`;
  const target = `${cdnOrigin.replace(/\/$/, "")}/releases/download/`;

  const rewriteRelease = (release: unknown): unknown => {
    if (!release || typeof release !== "object") return release;
    const record = release as Record<string, unknown>;
    if (!Array.isArray(record.assets)) return release;
    return {
      ...record,
      assets: record.assets.map((asset) => {
        if (!asset || typeof asset !== "object") return asset;
        const item = asset as Record<string, unknown>;
        const url = item.browser_download_url;
        if (typeof url === "string" && url.startsWith(prefix)) {
          return {
            ...item,
            browser_download_url: `${target}${url.slice(prefix.length)}`,
          };
        }
        return asset;
      }),
    };
  };

  return Array.isArray(payload) ? payload.map(rewriteRelease) : rewriteRelease(payload);
}

async function proxyBinary(
  request: Request,
  upstreamUrl: string,
  cacheTtl: number,
  cacheControl: string,
): Promise<Response> {
  const forwardHeaders = new Headers({
    "User-Agent": "tix-cdn-worker/1.0",
  });
  const range = request.headers.get("Range");
  if (range) forwardHeaders.set("Range", range);

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: forwardHeaders,
    redirect: "follow",
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": cacheTtl,
        "404": 30,
        "500-599": 0,
      },
    },
  });

  const headers = withCors(new Headers());
  for (const name of [
    "content-type",
    "content-length",
    "content-disposition",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", upstream.ok ? cacheControl : "no-store");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function proxyGitHubApi(apiUrl: string, env: Env, cacheTtl = 300): Promise<Response> {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "User-Agent": "tix-cdn-worker/1.0",
  });
  if (env.GITHUB_TOKEN) {
    headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);
  }

  const upstream = await fetch(apiUrl, {
    headers,
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": cacheTtl,
        "404": 30,
        "500-599": 0,
      },
    },
  });

  if (!upstream.ok) {
    return jsonResponse(
      { error: "Upstream GitHub API error", status: upstream.status },
      upstream.status,
      "no-store",
    );
  }

  const data = await upstream.json();
  const rewritten = rewriteReleaseAssetUrls(data, env.GITHUB_REPO, env.CDN_ORIGIN);
  return jsonResponse(rewritten, 200, `public, max-age=${cacheTtl}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: withCors(new Headers()) });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "Method not allowed" }, 405, "no-store");
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname.includes("..")) {
      return jsonResponse({ error: "Invalid path" }, 400, "no-store");
    }

    const repo = env.GITHUB_REPO || "penouc/tix";
    const branch = env.GITHUB_BRANCH || "main";

    if (pathname === "/" || pathname === "/health") {
      return jsonResponse({ ok: true, service: "tix-cdn", repo });
    }

    if (pathname === "/api/releases/latest") {
      return proxyGitHubApi(`https://api.github.com/repos/${repo}/releases/latest`, env);
    }

    if (pathname === "/api/releases") {
      return proxyGitHubApi(`https://api.github.com/repos/${repo}/releases?per_page=10`, env);
    }

    if (pathname === "/install.sh") {
      const response = await proxyBinary(
        request,
        `https://raw.githubusercontent.com/${repo}/${branch}/scripts/install.sh`,
        300,
        "public, max-age=300",
      );
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "text/x-shellscript; charset=utf-8");
      return new Response(response.body, { status: response.status, headers });
    }

    if (pathname === "/install.ps1") {
      const response = await proxyBinary(
        request,
        `https://raw.githubusercontent.com/${repo}/${branch}/scripts/install.ps1`,
        300,
        "public, max-age=300",
      );
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      return new Response(response.body, { status: response.status, headers });
    }

    if (pathname.startsWith("/releases/download/")) {
      const rest = pathname.slice("/releases/download/".length);
      if (!rest || rest.split("/").length < 2) {
        return jsonResponse({ error: "Invalid release download path" }, 400, "no-store");
      }
      return proxyBinary(
        request,
        `https://github.com/${repo}/releases/download/${rest}`,
        86400 * 30,
        "public, max-age=31536000, immutable",
      );
    }

    if (pathname.startsWith("/releases/latest/download/")) {
      const asset = pathname.slice("/releases/latest/download/".length);
      if (!asset || asset.includes("/")) {
        return jsonResponse({ error: "Invalid latest release asset path" }, 400, "no-store");
      }
      return proxyBinary(
        request,
        `https://github.com/${repo}/releases/latest/download/${asset}`,
        300,
        "public, max-age=300",
      );
    }

    return jsonResponse({ error: "Not found" }, 404, "no-store");
  },
};
