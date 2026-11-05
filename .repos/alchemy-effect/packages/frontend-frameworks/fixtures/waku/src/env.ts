// NOTE: a top-level `import { env } from "cloudflare:workers"` works too —
// SSG runs inside workerd via the cloudflare vite plugin's preview mode (see
// src/pages/ssg-env.tsx, which exercises exactly that). This guarded
// dynamic-import variant (the same trick waku's own adapter uses) is kept as
// the portable pattern for modules that must also load outside a Cloudflare
// environment.
const DO_NOT_BUNDLE = "";

export async function readEnv(): Promise<Record<string, unknown>> {
  try {
    const mod = await import(/* @vite-ignore */ DO_NOT_BUNDLE + "cloudflare:workers");
    return mod.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function readMessage(): Promise<string> {
  const env = await readEnv();
  return String(env.MESSAGE ?? "unset");
}
