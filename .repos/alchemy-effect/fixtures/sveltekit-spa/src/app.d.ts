declare global {
  namespace App {
    interface Platform {
      env?: {
        /**
         * A `Text.local` binding read by `/api/widgets` — proves +server.ts
         * endpoints still run server-side (with real bindings) even though
         * every page is `ssr = false`.
         */
        FIXTURE_MESSAGE?: string;
        ASSETS?: { fetch(input: Request | string | URL): Promise<Response> };
      };
      ctx?: { waitUntil(promise: Promise<unknown>): void };
    }
  }
}

export {};
