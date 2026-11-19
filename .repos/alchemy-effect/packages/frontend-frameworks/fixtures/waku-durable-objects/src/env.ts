// Guarded dynamic import of `cloudflare:workers` (the same trick waku's own
// adapter uses) so modules also load outside a Cloudflare environment.
const DO_NOT_BUNDLE = "";

export interface CounterStub {
  get(): Promise<number>;
  increment(): Promise<number>;
}

export interface CounterNamespace {
  getByName(name: string): CounterStub;
}

export async function readEnv(): Promise<Record<string, unknown>> {
  try {
    const mod = await import(/* @vite-ignore */ DO_NOT_BUNDLE + "cloudflare:workers");
    return mod.env as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function counterNamespace(): Promise<CounterNamespace | undefined> {
  const env = await readEnv();
  return env.COUNTER as CounterNamespace | undefined;
}
