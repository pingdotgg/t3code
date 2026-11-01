interface FixtureCache {
  match(key: string | Request): Promise<Response | undefined>;
  put(key: string | Request, response: Response): Promise<void>;
  delete(key: string | Request): Promise<boolean>;
}

interface FixtureKvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Virtual module served by the user Vite plugin in `vite.config.ts`. */
declare module "virtual:fixture-marker" {
  export const marker: string;
}

declare global {
  namespace App {
    interface Platform {
      env?: {
        FIXTURE_SECRET?: string;
        /**
         * Declared both as a Text binding and a dev `env` literal — the
         * literal wins in dev, the binding value serves live.
         */
        FIXTURE_OVERRIDE?: string;
        /**
         * A real KV namespace binding. In dev it is served through
         * cloudflare-runtime's platform proxy (calls round-trip to a
         * workerd-hosted local namespace).
         */
        FIXTURE_KV?: FixtureKvNamespace;
        ASSETS?: { fetch(input: Request | string | URL): Promise<Response> };
      };
      ctx?: { waitUntil(promise: Promise<unknown>): void };
      /**
       * Workers Cache API live; the platform proxy's cache in dev —
       * `put`/`match`/`delete` round-trip in both modes.
       */
      caches?: {
        default: FixtureCache;
        open(name: string): Promise<FixtureCache>;
      };
      /** `request.cf` live; wrangler-parity mock (via the proxy) in dev. */
      cf?: { colo?: string } & Record<string, unknown>;
    }
  }
}

export {};
