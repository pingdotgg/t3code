import * as Context from "effect/Context";

/**
 * The fixture root the harness operates in. Lives in its own module so that
 * `Options`/`Vite`/`Framework` can depend on it without importing `Runtime`
 * (which imports them back — an ESM cycle that breaks eager evaluation).
 */
export const Cwd = Context.Reference(
  "@alchemy.run/cloudflare-test-tools/e2e/Cwd",
  {
    defaultValue: () => process.cwd(),
  },
);
