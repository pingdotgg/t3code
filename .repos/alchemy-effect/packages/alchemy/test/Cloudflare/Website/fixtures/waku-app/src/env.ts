// Guarded dynamic import of `cloudflare:workers` (the same trick waku's own
// adapter uses): the portable way to reach Worker bindings from modules that
// must also load outside a Cloudflare environment — waku's SSG step renders
// static pages in Node, where a top-level `import { env } from
// "cloudflare:workers"` cannot resolve.
const DO_NOT_BUNDLE = "";

export async function readEnv(): Promise<Record<string, unknown>> {
  try {
    const mod = await import(
      /* @vite-ignore */ DO_NOT_BUNDLE + "cloudflare:workers"
    );
    return mod.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function readMessage(): Promise<string> {
  const env = await readEnv();
  return String(env.MESSAGE ?? "unset");
}
