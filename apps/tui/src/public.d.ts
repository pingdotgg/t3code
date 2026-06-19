// Public type surface for `@t3tools/tui`. Consumers (the server CLI) resolve
// their types from here so they never have to parse the package's JSX `.tsx`
// source — only the runtime resolves the built `dist/index.js`.
import type { TuiOptions } from "./connection.ts";

export type { TuiOptions };

/**
 * Entry point for the terminal UI. The host (the server CLI) does the loopback
 * auth bootstrap and hands us a ready-to-use {@link TuiOptions}: the server
 * origin, a bearer token, and a `mintSocketUrl` that returns a freshly-ticketed
 * websocket URL. We build the Effect runtime + RPC client and run the Ink app.
 */
export declare function runTui(options: TuiOptions): Promise<void>;
