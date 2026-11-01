import type * as cf from "@cloudflare/workers-types";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Application, ApplicationProps } from "../Access/Application.ts";

/**
 * Protect this Worker with Cloudflare Access (`access` prop). Two forms:
 *
 * - a `Cloudflare.Access.Application` — enroll into a **shared**
 *   application (one policy set across several Workers). Note Access
 *   policies are application-wide: every Worker enrolled in the
 *   application is gated by the same policies.
 * - `{ policies, ... }` — a **dedicated** application owned by this
 *   Worker, created/updated/deleted with it. Access configuration
 *   (policies, session duration, IdPs) lives on applications, so
 *   per-Worker configuration means a per-Worker application — this form
 *   declares one for you, namespaced under the Worker (`<Worker>/Access`).
 *
 * Either way, enrolling pushes this Worker's `worker` destination (and a
 * `preview_worker` destination unless `previews: false`) onto the
 * application through its binding contract, so the application deploys
 * with — and converges on — the destinations of every enrolled Worker.
 * Removing the prop (or the Worker) un-enrolls it on the application's
 * next reconcile.
 */
export type WorkerAccessConfig = Application | WorkerAccessApplication;

/**
 * A dedicated Access application owned by this Worker — per-Worker
 * policies without declaring the application yourself.
 */
export interface WorkerAccessApplication {
  /**
   * Policies gating access to this Worker — inline bodies, reusable
   * `Cloudflare.Access.Policy` resources, or policy ids (see
   * `ApplicationProps["policies"]`).
   */
  policies: NonNullable<ApplicationProps["policies"]>;
  /** Display name for the application. Auto-generated when omitted. */
  name?: string;
  /** Session lifetime, e.g. `"24h"`. */
  sessionDuration?: string;
  /** Allowed identity-provider UUIDs. */
  allowedIdps?: string[];
  /** Skip the IdP picker when exactly one IdP is allowed. */
  autoRedirectToIdentity?: boolean;
  /** Show the application in the App Launcher dashboard. */
  appLauncherVisible?: boolean;
  /**
   * Also protect the Worker's version preview URLs.
   * @default true
   */
  previews?: boolean;
}

export class WorkerAccessIdentityError extends Data.TaggedError(
  "WorkerAccessIdentityError",
)<{
  message: string;
  cause?: unknown;
}> {}

/**
 * The identity Cloudflare Access authenticated for the current request,
 * as resolved by `ctx.access.getIdentity()`. Field names follow the wire
 * format of Access's identity payload (snake_case); identity providers can
 * attach additional fields, captured by the index signature.
 */
export interface WorkerAccessIdentity {
  /** The user's email address, if the identity provider supplies one. */
  readonly email?: string;
  /** The user's display name. */
  readonly name?: string;
  /** The user's unique identifier. */
  readonly user_uuid?: string;
  /** The Cloudflare account id the Access organization belongs to. */
  readonly account_id?: string;
  /** Login timestamp (Unix epoch seconds). */
  readonly iat?: number;
  /** The user's IP address at authentication time. */
  readonly ip?: string;
  /** Authentication methods used (e.g. `"pwd"`). */
  readonly amr?: string[];
  /** Identity-provider information. */
  readonly idp?: { id: string; type: string };
  /** Where the user authenticated from. */
  readonly geo?: { country: string };
  /** Group memberships from the identity provider. */
  readonly groups?: Array<{ id: string; name: string; email?: string }>;
  /** Device posture check results, keyed by check id. */
  readonly devicePosture?: Record<string, unknown>;
  /** True when the user connected via Cloudflare WARP. */
  readonly is_warp?: boolean;
  /** True when the user is authenticated via Cloudflare Gateway. */
  readonly is_gateway?: boolean;
  /** Service-token client id, when authenticated via a service token. */
  readonly service_token_id?: string;
  /** True when the request authenticated with a service token. */
  readonly service_token_status?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Effect-native view of the Cloudflare Access runtime API on the execution
 * context (`ctx.access`). Present only when the request was admitted by a
 * Cloudflare Access policy (see the `access` prop on `Cloudflare.Worker`),
 * or when simulated locally via the Worker's `dev.access` config.
 */
export interface WorkerExecutionContextAccess {
  /** The Access application audience (AUD) tag that admitted this request. */
  readonly aud: string;
  /**
   * Resolve the authenticated identity — email, name, groups, device
   * posture, etc. Resolves `undefined` when Access has no identity for the
   * request (e.g. some service-token flows).
   */
  getIdentity(): Effect.Effect<
    WorkerAccessIdentity | undefined,
    WorkerAccessIdentityError,
    RuntimeContext
  >;
}

/**
 * The shape workerd exposes on `ctx.access` (typed locally — this package's
 * workers-types predates it) and that the local dev simulation mirrors.
 */
interface RawAccessContext {
  readonly aud: string;
  getIdentity(): Promise<WorkerAccessIdentity | undefined>;
}

const makeAccessContext = (
  raw: RawAccessContext,
): WorkerExecutionContextAccess => ({
  aud: raw.aud,
  getIdentity: () =>
    Effect.tryPromise({
      try: () => raw.getIdentity(),
      catch: (cause) =>
        new WorkerAccessIdentityError({
          message:
            cause instanceof Error
              ? cause.message
              : "Unknown Access identity resolution error",
          cause,
        }),
    }),
});

/** The env key `dev.access` is lowered into by the local worker provider. */
export const DEV_ACCESS_ENV_KEY = "ALCHEMY_DEV_ACCESS";

/**
 * Resolve the current request's Access context: workerd's native
 * `ctx.access` when the request came through Cloudflare Access, the
 * `dev.access` simulation under `alchemy dev`, and `undefined` (an
 * unauthenticated request) otherwise. Backs the `access` member of the
 * per-event `WorkerExecutionContext`.
 */
export const resolveAccessContext = (
  ctx: cf.ExecutionContext,
  env: Record<string, unknown> | undefined,
): WorkerExecutionContextAccess | undefined => {
  // Deployed behind Access: workerd populates ctx.access natively.
  const native = (ctx as cf.ExecutionContext & { access?: RawAccessContext })
    .access;
  if (native !== undefined) {
    return makeAccessContext(native);
  }
  // Local dev: the Worker's `dev.access` config is lowered into an env
  // binding; absent config simulates an unauthenticated request.
  const dev = env?.[DEV_ACCESS_ENV_KEY] as
    | { aud?: string; identity?: WorkerAccessIdentity }
    | undefined;
  if (dev !== undefined) {
    return {
      aud: dev.aud ?? "dev",
      getIdentity: () => Effect.succeed(dev.identity),
    };
  }
  return undefined;
};
