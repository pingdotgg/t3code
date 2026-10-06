import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  firewallNameOf,
  lastSegment,
  sameText,
  toGeneratedPath,
  updateMaskOf,
  getFirewallPolicy,
} from "./internal.ts";

export type FirewallActionSetHeader = {
  /**
   * Header name to set on the request.
   */
  key?: string;
  /**
   * Header value to set on the request.
   */
  value?: string;
};

export type FirewallActionSubstitute = {
  /**
   * Relative path to serve instead of the original request path.
   */
  path?: string;
};

export type FirewallAction = {
  /**
   * Allow the request. Terminal.
   */
  allow?: Record<string, never> | {};
  /**
   * Deny the request. Terminal.
   */
  block?: Record<string, never> | {};
  /**
   * Include the reCAPTCHA JavaScript on the page. Non-terminal.
   */
  includeRecaptchaScript?: Record<string, never> | {};
  /**
   * Redirect to a reCAPTCHA challenge page. Terminal.
   */
  redirect?: Record<string, never> | {};
  /**
   * Attach a request header. Non-terminal.
   */
  setHeader?: FirewallActionSetHeader;
  /**
   * Serve a different path. Terminal.
   */
  substitute?: FirewallActionSubstitute;
};

export type FirewallpolicyProps = {
  /**
   * Server-assigned policy id (the `{firewallpolicy}` segment of
   * `projects/{project}/firewallpolicies/{firewallpolicy}`). Immutable —
   * changing it replaces the policy.
   */
  firewallpolicyId?: string;
  /**
   * Request path glob this policy matches (max 200 characters). If
   * omitted, a unique `/alc/{name}` path is generated.
   */
  path?: string;
  /**
   * Human-readable description (max 256 characters).
   */
  description?: string;
  /**
   * CEL condition. The policy applies when this evaluates to true and
   * the path matches. Max 500 characters.
   */
  condition?: string;
  /**
   * Actions to take. At most one terminal action (`allow`, `block`,
   * `redirect`, `substitute`). Up to 16 actions.
   * @default [{ allow: {} }]
   */
  actions?: FirewallAction[];
};

export type Firewallpolicy = Resource<
  "GCP.RecaptchaEnterprise.Firewallpolicy",
  FirewallpolicyProps,
  {
    /** Full resource name `projects/{project}/firewallpolicies/{id}`. */
    name: string;
    /** Server-assigned policy id (last path segment). */
    firewallpolicyId: string;
    /** Project id used when the policy was reconciled. */
    project: string;
    /** Path glob this policy matches. */
    path: string | undefined;
    /** Policy description. */
    description: string | undefined;
    /** CEL condition, if set. */
    condition: string | undefined;
    /** Configured actions. */
    actions: FirewallAction[];
  },
  never,
  Providers
>;

/**
 * A reCAPTCHA Enterprise firewall policy.
 *
 * Policies have no labels field and a server-assigned id, so only a
 * recorded policy can be read back. The policy id is assigned by Google —
 * changing `firewallpolicyId` replaces the policy. Path, description,
 * condition, and actions update in place.
 *
 * ### Creating a Policy
 * **Example:** Allow a login path
 * ```typescript
 * const policy = yield* GCP.RecaptchaEnterprise.Firewallpolicy("Login", {
 *   path: "/login",
 *   description: "allow login",
 *   actions: [{ allow: {} }],
 * });
 * ```
 *
 * **Example:** Block with a CEL condition
 * ```typescript
 * const policy = yield* GCP.RecaptchaEnterprise.Firewallpolicy("Bot", {
 *   path: "/checkout",
 *   condition: "true",
 *   actions: [{ block: {} }],
 * });
 * ```
 *
 * ### Updating a Policy
 * **Example:** Change the path and action
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const policy = yield* GCP.RecaptchaEnterprise.Firewallpolicy("Login", {
 *   path: "/signin",
 *   description: "allow sign-in",
 *   actions: [{ allow: {} }],
 * });
 * ```
 *
 * @resource
 * @category RecaptchaEnterprise
 */
export const Firewallpolicy = Resource<Firewallpolicy>(
  "GCP.RecaptchaEnterprise.Firewallpolicy",
);

export class FirewallpolicyNotResolved extends Data.TaggedError(
  "GCP.RecaptchaEnterprise.FirewallpolicyNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_ACTIONS: FirewallAction[] = [{ allow: {} }];

const emptyAction = (value: unknown) => (value === undefined ? undefined : {});

const toAction = (
  action:
    | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1FirewallAction
    | FirewallAction,
): FirewallAction => ({
  allow: emptyAction(action.allow),
  block: emptyAction(action.block),
  includeRecaptchaScript: emptyAction(action.includeRecaptchaScript),
  redirect: emptyAction(action.redirect),
  setHeader:
    action.setHeader === undefined
      ? undefined
      : {
          key: action.setHeader.key,
          value: action.setHeader.value,
        },
  substitute:
    action.substitute === undefined
      ? undefined
      : { path: action.substitute.path },
});

const compactAction = (action: FirewallAction): FirewallAction => {
  const next: FirewallAction = {};
  if (action.allow !== undefined) next.allow = {};
  if (action.block !== undefined) next.block = {};
  if (action.includeRecaptchaScript !== undefined) {
    next.includeRecaptchaScript = {};
  }
  if (action.redirect !== undefined) next.redirect = {};
  if (action.setHeader !== undefined) next.setHeader = action.setHeader;
  if (action.substitute !== undefined) next.substitute = action.substitute;
  return next;
};

const toActions = (
  actions:
    | readonly (
        | recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1FirewallAction
        | FirewallAction
      )[]
    | undefined,
): FirewallAction[] => (actions ?? []).map((action) => toAction(action));

const desiredActions = (news: FirewallpolicyProps): FirewallAction[] =>
  (news.actions ?? DEFAULT_ACTIONS).map(compactAction);

const actionsFingerprint = (actions: readonly FirewallAction[]) =>
  JSON.stringify(actions.map(compactAction));

const toAttrs = (
  policy: recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1FirewallPolicy,
  project: string,
) => {
  const name = policy.name ?? "";
  return {
    name,
    firewallpolicyId: lastSegment(name),
    project,
    path: policy.path,
    description: policy.description,
    condition: policy.condition,
    actions: toActions(policy.actions),
  };
};

const toBody = (
  path: string,
  description: string | undefined,
  condition: string | undefined,
  actions: FirewallAction[],
): recaptchaenterprise.GoogleCloudRecaptchaenterpriseV1FirewallPolicy => ({
  path,
  description,
  condition,
  actions,
});

export const FirewallpolicyProvider = () =>
  Provider.succeed(Firewallpolicy, {
    stables: ["name", "firewallpolicyId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.firewallpolicyId ?? output?.firewallpolicyId;
      if (
        news.firewallpolicyId !== undefined &&
        previousId !== undefined &&
        news.firewallpolicyId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      // Server-assigned id: only a recorded policy can be observed.
      const name =
        output?.name ??
        (olds?.firewallpolicyId !== undefined
          ? firewallNameOf(env.project, olds.firewallpolicyId)
          : "");
      const existing = yield* getFirewallPolicy(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const description = news.description;
      const path = yield* toGeneratedPath(id, news.path);
      const actions = desiredActions(news);
      const condition = news.condition;
      const lookupName =
        output?.name ??
        (news.firewallpolicyId !== undefined
          ? firewallNameOf(env.project, news.firewallpolicyId)
          : output?.firewallpolicyId !== undefined
            ? firewallNameOf(env.project, output.firewallpolicyId)
            : "");

      let current = yield* getFirewallPolicy(lookupName);

      if (current === undefined) {
        const created = yield* recaptchaenterprise
          .createProjectsFirewallpolicies({
            parent: `projects/${env.project}`,
            body: toBody(path, description, condition, actions),
          })
          .pipe(
            Effect.catchTag("Conflict", () => getFirewallPolicy(lookupName)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new FirewallpolicyNotResolved({
          name: lookupName.length > 0 ? lookupName : path,
        });
      }

      const name = current.name ?? lookupName;
      const pathChanged = !sameText(current.path, path);
      const descriptionChanged = !sameText(current.description, description);
      const conditionChanged = !sameText(current.condition, condition);
      const actionsChanged =
        actionsFingerprint(toActions(current.actions)) !==
        actionsFingerprint(actions);

      const updateMask = updateMaskOf(
        pathChanged ? "path" : undefined,
        descriptionChanged ? "description" : undefined,
        conditionChanged ? "condition" : undefined,
        actionsChanged ? "actions" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* recaptchaenterprise.patchProjectsFirewallpolicies({
          name,
          updateMask,
          body: { ...toBody(path, description, condition, actions), name },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* recaptchaenterprise
        .deleteProjectsFirewallpolicies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
