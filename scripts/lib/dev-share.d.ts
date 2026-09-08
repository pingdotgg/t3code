/**
 * Shares a running dev server on the local tailnet via `tailscale serve`, so it
 * can be opened from a phone, another laptop, or by whoever is reviewing the
 * work.
 *
 * Thin wrapper over `@t3tools/tailscale` (the same client the server's own
 * `--tailscale-serve` uses). What it adds is dev-share semantics: replacing a
 * stale mapping left by a killed run, and refusing to serve over routes it
 * could not remove.
 *
 * Because browser dev is single-origin (Vite proxies the backend — see
 * `resolveDevProxyTarget` in apps/web/vite.config.ts), one proxy rule covering
 * the web port is enough; the backend needs no mapping of its own.
 */
import { type TailscaleCommandError } from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChildProcessSpawner } from "effect/unstable/process";
declare const TailscaleUnavailableError_base: Schema.Class<
  TailscaleUnavailableError,
  Schema.TaggedStruct<
    "TailscaleUnavailableError",
    {
      readonly cause: Schema.Defect;
    }
  >,
  import("effect/Cause").YieldableError
>;
/**
 * Three distinct failures, three classes: each has its own caller-visible
 * message and its own remedy, and `shareDevServer` chooses between them
 * structurally. A single error with a `reason` discriminator would encode that
 * distinction twice and put a lookup table in the `message` getter.
 *
 * Each wraps a real underlying failure and so keeps it as `cause`; the message
 * is derived only from the structural fields, never from `cause.message`.
 */
export declare class TailscaleUnavailableError extends TailscaleUnavailableError_base {
  get message(): string;
  get hint(): string;
}
declare const TailnetNameMissingError_base: Schema.Class<
  TailnetNameMissingError,
  Schema.TaggedStruct<"TailnetNameMissingError", {}>,
  import("effect/Cause").YieldableError
>;
/** No underlying failure: the status read succeeded and simply had no name. */
export declare class TailnetNameMissingError extends TailnetNameMissingError_base {
  get message(): string;
  get hint(): string;
}
declare const DevServeFailedError_base: Schema.Class<
  DevServeFailedError,
  Schema.TaggedStruct<
    "DevServeFailedError",
    {
      readonly stage: Schema.Literals<readonly ["clear-existing", "serve"]>;
      readonly webPort: Schema.Number;
      readonly explanation: Schema.optional<Schema.String>;
      readonly cause: Schema.optional<Schema.Defect>;
    }
  >,
  import("effect/Cause").YieldableError
>;
/**
 * `stage` is a genuine multi-value discriminator: both stages share the same
 * semantics (a `tailscale serve` invocation failed for this port) and differ
 * only in which one, which the message states plainly.
 */
export declare class DevServeFailedError extends DevServeFailedError_base {
  get message(): string;
  get hint(): undefined;
}
export declare const DevShareError: Schema.Union<
  readonly [
    typeof TailscaleUnavailableError,
    typeof TailnetNameMissingError,
    typeof DevServeFailedError,
  ]
>;
export type DevShareError = typeof DevShareError.Type;
export declare const isDevShareError: <I>(
  input: I,
) => input is I & (DevServeFailedError | TailnetNameMissingError | TailscaleUnavailableError);
/**
 * Removes any mapping for `webPort`, reporting whether the port is now clear.
 *
 * Runs uninterruptibly: this is called from a finalizer on the way out of an
 * interrupted program, and cancelling the cleanup subprocess would leave
 * exactly the stale mapping it exists to remove.
 */
export declare const unshareDevServer: (webPort: number) => Effect.Effect<
  {
    readonly cleared: boolean;
    readonly explanation?: string | undefined;
    readonly cause?: TailscaleCommandError | undefined;
  },
  never,
  ChildProcessSpawner.ChildProcessSpawner
>;
export interface DevShareResult {
  readonly url: string;
  readonly host: string;
}
/**
 * Publishes `webPort` on the tailnet at the same port number and returns the
 * resulting HTTPS URL. Idempotent: re-running replaces any existing mapping.
 */
export declare const shareDevServer: (input: { readonly webPort: number }) => Effect.Effect<
  {
    url: string;
    host: string;
  },
  DevServeFailedError | TailnetNameMissingError | TailscaleUnavailableError,
  ChildProcessSpawner.ChildProcessSpawner
>;
export {};
