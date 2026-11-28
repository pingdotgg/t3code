// Augments OpenNext's `CloudflareEnv` with the bindings the tests wire in
// (structural types — no dependency on @cloudflare/workers-types).
declare global {
  interface CloudflareEnv {
    TEST_TEXT?: string;
    FIXTURE_KV: {
      get(key: string): Promise<string | null>;
      put(key: string, value: string): Promise<void>;
    };
  }
}

export {};
