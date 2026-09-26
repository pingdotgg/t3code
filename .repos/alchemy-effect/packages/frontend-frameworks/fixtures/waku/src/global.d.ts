declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
  export const waitUntil: (promise: Promise<unknown>) => void;
}

// Served by the user vite plugin declared in waku.config.ts.
declare module "virtual:fixtures-waku/user-config-marker" {
  export const marker: string;
}
