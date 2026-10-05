// Ambient SvelteKit types for the example. `App.Platform` mirrors what the
// Cloudflare adapter provides at runtime — declared here so the example
// type-checks before the first `svelte-kit sync`.
declare global {
  namespace App {
    interface Platform {
      env?: {
        GREETING?: string;
      };
    }
  }
}

export {};
