import * as workers from "@distilled.cloud/cloudflare/workers";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.IssueAutomation" as const;
type TypeId = typeof TypeId;

/**
 * What makes an automation notify: an issue reaching an occurrence count,
 * or an issue recurring after a period of inactivity.
 */
export type IssueAutomationTriggerType = workers.ObservabilityIssueAutomationTriggerType;

export interface IssueAutomationProps {
  /**
   * Name of the automation. If omitted, a unique name is generated.
   * Mutable — renames are applied in place.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Id of the notification policy to notify. Use a
   * `Cloudflare.Alerting.NotificationPolicy` with alert type
   * `workers_observability_real_time_issue`; its mechanisms decide where
   * the notification goes (email, webhook, PagerDuty). Cloudflare does not
   * check that the policy exists.
   */
  policyId: string;
  /**
   * Limit the automation to one Worker, by script name. Omit to cover
   * every Worker in the account.
   */
  service?: string;
  /**
   * Notify once an issue has occurred this many times. Set exactly one of
   * `afterOccurrences` and `afterInactivitySeconds`.
   */
  afterOccurrences?: number;
  /**
   * Notify when an issue occurs again after this many seconds without
   * occurrences (3600 to 31536000). Set exactly one of `afterOccurrences`
   * and `afterInactivitySeconds`.
   */
  afterInactivitySeconds?: number;
  /**
   * Whether the automation is enabled.
   * @default true
   */
  enabled?: boolean;
}

export interface IssueAutomationAttributes {
  /** Cloudflare-assigned automation id. */
  automationId: string;
  /** Account that owns this automation. */
  accountId: string;
  /** Name of the automation. */
  name: string;
  /** Id of the notification policy the automation notifies. */
  policyId: string;
  /** Worker the automation is limited to, if any. */
  service: string | undefined;
  /** `service` when limited to one Worker, otherwise `account`. */
  scope: workers.ObservabilityIssueAutomationScope;
  /** What makes the automation notify. */
  triggerType: IssueAutomationTriggerType;
  /** Occurrence count for an `occurrence_threshold` trigger. */
  afterOccurrences: number | undefined;
  /** Inactivity period for a `recurrence_after_inactivity` trigger. */
  afterInactivitySeconds: number | undefined;
  /** Whether the automation is enabled. */
  enabled: boolean;
  /** Revision, incremented by Cloudflare on every update. */
  revision: number;
}

export type IssueAutomation = Resource<
  TypeId,
  IssueAutomationProps,
  IssueAutomationAttributes,
  never,
  Providers
>;

/**
 * A Workers Issues automation.
 *
 * [Workers Issues](https://developers.cloudflare.com/workers/observability/issues/)
 * groups a Worker's errors into issues. An automation sends a notification
 * when an issue reaches an occurrence count, or comes back after a quiet
 * period. It notifies a `workers_observability_real_time_issue`
 * notification policy, which decides where the notification goes.
 *
 * Automations carry no ownership markers. When there is no prior state,
 * `read` finds an automation by name and reports it as `Unowned`, so the
 * engine only takes it over with `--adopt`.
 * ### Notifying on issues
 * **Example:** Email after five occurrences of any issue
 * ```typescript
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
 *   alertType: "workers_observability_real_time_issue",
 *   mechanisms: { email: [{ id: "ops@example.com" }] },
 * });
 *
 * yield* Cloudflare.Workers.IssueAutomation("IssueAlerts", {
 *   policyId: policy.policyId,
 *   afterOccurrences: 5,
 * });
 * ```
 *
 * **Example:** Notify when an issue comes back after a quiet day
 * ```typescript
 * yield* Cloudflare.Workers.IssueAutomation("Regressions", {
 *   policyId: policy.policyId,
 *   afterInactivitySeconds: 86_400,
 * });
 * ```
 *
 * ### Sending issues to a webhook or agent
 * **Example:** Post one Worker's issues to a webhook
 * ```typescript
 * const webhook = yield* Cloudflare.Alerting.NotificationWebhook("IssueHook", {
 *   url: "https://agent.example.com/issues",
 * });
 *
 * const policy = yield* Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
 *   alertType: "workers_observability_real_time_issue",
 *   mechanisms: { webhooks: [{ id: webhook.webhookId }] },
 * });
 *
 * yield* Cloudflare.Workers.IssueAutomation("ApiIssues", {
 *   policyId: policy.policyId,
 *   service: worker.workerName,
 *   afterOccurrences: 1,
 * });
 * ```
 *
 * ### Handling issues in code
 * **Example:** Open a GitHub issue for every new Worker issue
 * A Worker only records issues with `observability.issues.enabled`.
 * `consumeNotifications` points the policy at the handling Worker, so the
 * policy declares no `mechanisms`.
 * ```typescript
 * const Repo = GitHub.Repository("Repo", { owner: "acme", name: "api" });
 *
 * const IssuePolicy = Cloudflare.Alerting.NotificationPolicy("IssuePolicy", {
 *   alertType: "workers_observability_real_time_issue",
 * });
 *
 * class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, observability: { enabled: true, issues: { enabled: true } } },
 *   Effect.gen(function* () {
 *     const policy = yield* IssuePolicy;
 *     const createIssue = yield* GitHub.CreateIssue(yield* Repo);
 *     yield* Cloudflare.Alerting.consumeNotifications(policy, (notification) =>
 *       createIssue({ title: notification.text.split("\n")[0], body: notification.text }),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(Cloudflare.Alerting.NotificationEventSourceLive, GitHub.CreateIssueHttp),
 *     ),
 *   ),
 * ) {}
 *
 * const Stack = Effect.gen(function* () {
 *   yield* Repo;
 *   const policy = yield* IssuePolicy;
 *   const api = yield* Api;
 *   yield* Cloudflare.Workers.IssueAutomation("ApiIssues", {
 *     policyId: policy.policyId,
 *     service: api.workerName,
 *     afterOccurrences: 1,
 *   });
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/workers/observability/issues/
 *
 * @resource
 * @product Workers
 * @category Observability & Analytics
 */
export const IssueAutomation = Resource<IssueAutomation>(TypeId);

/**
 * Returns true if the given value is an IssueAutomation resource.
 */
export const isIssueAutomation = (value: unknown): value is IssueAutomation =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const IssueAutomationProvider = () =>
  Provider.succeed(IssueAutomation, {
    stables: ["automationId", "accountId"],

    diff: Effect.fn(function* ({ output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path: refresh by the persisted automation id.
      if (output?.automationId) {
        const observed = yield* observeAutomation(acct, output.automationId);
        return observed ? toAttributes(observed, acct) : undefined;
      }

      // No state of our own: look the automation up by name. Automations
      // carry no ownership markers, so brand a match `Unowned` and let the
      // engine gate takeover behind the adopt policy.
      const name = olds?.name ?? (yield* createAutomationName(id));
      const observed = yield* findAutomationByName(acct, name);
      return observed ? Unowned(toAttributes(observed, acct)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Prefer the deployed name: regenerating would target a different
      // automation if the generator's output for this id ever drifts.
      const name = news.name ?? output?.name ?? (yield* createAutomationName(id));
      const desired = buildBody(name, news);

      // 1. Observe — by cached id first, then by name (ownership of a name
      //    match has already been checked by `read` + the adopt policy).
      let observed: workers.ObservabilityIssueAutomation | undefined;
      if (output?.automationId) {
        observed = yield* observeAutomation(accountId, output.automationId);
      }
      if (!observed) {
        observed = yield* findAutomationByName(accountId, name);
      }

      // 2. Ensure — create when missing.
      if (!observed) {
        const { automation } = yield* workers.createObservabilityIssueAutomation({
          accountId,
          ...desired,
        });
        return toAttributes(automation, accountId);
      }

      // 3. Sync — PUT is a full replace, so send the whole desired body
      //    when any field drifts from the observed automation.
      if (!matchesObserved(desired, observed)) {
        const { automation } = yield* workers.updateObservabilityIssueAutomation({
          accountId,
          automationId: observed.id,
          ...desired,
        });
        return toAttributes(automation, accountId);
      }

      // 4. Return.
      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* workers
        .deleteObservabilityIssueAutomation({
          accountId: output.accountId,
          automationId: output.automationId,
        })
        .pipe(Effect.catchTag("ObservabilityIssueAutomationNotFound", () => Effect.void));
    }),

    // Account collection. The list endpoint returns every account- and
    // service-scoped automation in one response.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { automations } = yield* workers.listObservabilityIssueAutomations({ accountId });
      return automations.map((automation) => toAttributes(automation, accountId));
    }),
  });

type AutomationBody = Omit<workers.CreateObservabilityIssueAutomationRequest, "accountId">;

const createAutomationName = (id: string) => createPhysicalName({ id, lowercase: true });

const buildBody = (name: string, news: IssueAutomationProps): AutomationBody => ({
  name,
  policyId: news.policyId,
  enabled: news.enabled ?? true,
  service: news.service,
  afterOccurrences: news.afterOccurrences,
  afterInactivitySeconds: news.afterInactivitySeconds,
});

const matchesObserved = (
  desired: AutomationBody,
  observed: workers.ObservabilityIssueAutomation,
): boolean =>
  desired.name === observed.name &&
  desired.policyId === observed.ansPolicyId &&
  desired.enabled === observed.enabled &&
  desired.service === (observed.service ?? undefined) &&
  desired.afterOccurrences === (observed.threshold ?? undefined) &&
  desired.afterInactivitySeconds === (observed.inactivitySeconds ?? undefined);

const observeAutomation = (accountId: string, automationId: string) =>
  workers.getObservabilityIssueAutomation({ accountId, automationId }).pipe(
    Effect.map(({ automation }) => automation),
    Effect.catchTag("ObservabilityIssueAutomationNotFound", () => Effect.undefined),
  );

const findAutomationByName = (accountId: string, name: string) =>
  workers
    .listObservabilityIssueAutomations({ accountId })
    .pipe(Effect.map(({ automations }) => automations.find((a) => a.name === name)));

const toAttributes = (
  observed: workers.ObservabilityIssueAutomation,
  accountId: string,
): IssueAutomationAttributes => ({
  automationId: observed.id,
  accountId,
  name: observed.name,
  policyId: observed.ansPolicyId,
  service: observed.service ?? undefined,
  scope: observed.scope,
  triggerType: observed.triggerType,
  afterOccurrences: observed.threshold ?? undefined,
  afterInactivitySeconds: observed.inactivitySeconds ?? undefined,
  enabled: observed.enabled,
  revision: observed.revision,
});
