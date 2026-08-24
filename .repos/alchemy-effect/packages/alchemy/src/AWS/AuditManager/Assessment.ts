import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord, unredact } from "./internal.ts";

/**
 * Where Audit Manager stores generated assessment reports.
 */
export interface AssessmentReportsDestinationProps {
  /**
   * The destination type. Only `S3` is supported.
   * @default "S3"
   */
  destinationType?: auditmanager.AssessmentReportDestinationType;
  /**
   * The destination bucket, as an S3 URL (e.g. `s3://my-bucket`).
   */
  destination: string;
}

/**
 * An AWS account included in the scope of an assessment.
 */
export interface AssessmentScopeAccount {
  /**
   * The account id.
   */
  id: string;
}

/**
 * An AWS service included in the scope of an assessment.
 */
export interface AssessmentScopeService {
  /**
   * The service name (e.g. `s3`, `iam`).
   */
  serviceName: string;
}

/**
 * The accounts and services an assessment collects evidence for.
 */
export interface AssessmentScope {
  /**
   * The accounts in scope.
   */
  awsAccounts?: AssessmentScopeAccount[];
  /**
   * The services in scope. Omit to let Audit Manager infer services from
   * the in-scope accounts.
   */
  awsServices?: AssessmentScopeService[];
}

/**
 * A user or role responsible for an assessment.
 */
export interface AssessmentRole {
  /**
   * The role type — `PROCESS_OWNER` or `RESOURCE_OWNER`.
   */
  roleType: auditmanager.RoleType;
  /**
   * ARN of the IAM user or role.
   */
  roleArn: string;
}

export interface AssessmentProps {
  /**
   * Name of the assessment.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * A description of the assessment.
   */
  description?: string;
  /**
   * The unique identifier of the framework the assessment is created from.
   * Changing it replaces the assessment.
   */
  frameworkId: string;
  /**
   * Where generated assessment reports are stored.
   */
  assessmentReportsDestination: AssessmentReportsDestinationProps;
  /**
   * The accounts and services in scope.
   * @default the current account
   */
  scope?: AssessmentScope;
  /**
   * The users and roles responsible for the assessment.
   */
  roles: AssessmentRole[];
  /**
   * Tags to associate with the assessment.
   */
  tags?: Record<string, string>;
}

export interface Assessment extends Resource<
  "AWS.AuditManager.Assessment",
  AssessmentProps,
  {
    /**
     * Service-assigned unique identifier of the assessment.
     */
    assessmentId: string;
    /**
     * ARN of the assessment.
     */
    arn: string;
    /**
     * The assessment's name.
     */
    name: string;
    /**
     * Current status of the assessment (`ACTIVE` or `INACTIVE`).
     */
    status: auditmanager.AssessmentStatus | undefined;
    /**
     * The id of the framework the assessment was created from.
     */
    frameworkId: string;
    /**
     * Current tags reported for the assessment.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Audit Manager assessment — an active evidence-collection engagement
 * created from a framework, continuously gathering evidence for the controls
 * in scope.
 *
 * :::note
 * Audit Manager must be registered in the account (`RegisterAccount`)
 * before assessments can be created.
 * :::
 * @resource
 * @section Creating Assessments
 * @example Assessment from a Custom Framework
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const reports = yield* AWS.S3.Bucket("AuditReports", {});
 *
 * const owner = yield* AWS.IAM.Role("AuditOwner", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [{
 *       Effect: "Allow",
 *       Principal: { Service: "auditmanager.amazonaws.com" },
 *       Action: ["sts:AssumeRole"],
 *     }],
 *   },
 * });
 *
 * const assessment = yield* AWS.AuditManager.Assessment("Quarterly", {
 *   frameworkId: framework.frameworkId,
 *   assessmentReportsDestination: {
 *     destination: reports.bucketName.apply((name) => `s3://${name}`),
 *   },
 *   roles: [{ roleType: "PROCESS_OWNER", roleArn: owner.roleArn }],
 * });
 * ```
 */
export const Assessment = Resource<Assessment>("AWS.AuditManager.Assessment");

const createAssessmentName = (
  id: string,
  props: { name?: string | undefined },
) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 100 });

const toAttributes = (
  assessment: auditmanager.Assessment,
): Assessment["Attributes"] => ({
  assessmentId: assessment.metadata?.id ?? "",
  arn: assessment.arn ?? "",
  name: unredact(assessment.metadata?.name) ?? "",
  status: assessment.metadata?.status,
  frameworkId: assessment.framework?.id ?? "",
  tags: toTagRecord(assessment.tags),
});

const readAssessmentById = Effect.fn(function* (assessmentId: string) {
  const response = yield* auditmanager
    .getAssessment({ assessmentId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return response?.assessment;
});

const findAssessmentByName = Effect.fn(function* (name: string) {
  const pages = yield* auditmanager.listAssessments
    .pages({})
    .pipe(EffectStream.runCollect);
  const match = Array.from(pages)
    .flatMap((page) => page.assessmentMetadata ?? [])
    .find(
      (assessment) =>
        unredact(assessment.name) === name && assessment.status !== "INACTIVE",
    );
  if (!match?.id) return undefined;
  return yield* readAssessmentById(match.id);
});

/**
 * Projection of the mutable assessment surface used for drift detection.
 */
const projectAssessment = (input: {
  name: string;
  description: string;
  destinationType: string;
  destination: string;
  accountIds: string[];
  serviceNames: string[];
  roles: { roleType: string; roleArn: string }[];
}) => ({
  ...input,
  accountIds: [...input.accountIds].sort(),
  serviceNames: [...input.serviceNames].sort(),
  roles: [...input.roles].sort((l, r) =>
    `${l.roleArn}:${l.roleType}`.localeCompare(`${r.roleArn}:${r.roleType}`),
  ),
});

// CreateAssessment validates the process-owner IAM roles up front; a
// freshly-created role may not have propagated yet and surfaces as
// ValidationException. Bounded retry through the propagation window (~60s).
// Explicitly typed — an inline `Effect.retry` in provider lifecycle code
// leaks `Retry.Return`'s conditional type into declaration emit and widens
// the provider layer to `unknown` for every consumer of `AWS.providers()`.
const retryThroughIamPropagation = <A, E extends { readonly _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "ValidationException",
    schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)]),
  });

export const AssessmentProvider = () =>
  Provider.effect(
    Assessment,
    Effect.gen(function* () {
      return {
        stables: ["assessmentId", "arn"],
        list: () =>
          Effect.gen(function* () {
            const pages = yield* auditmanager.listAssessments
              .pages({})
              .pipe(EffectStream.runCollect);
            const ids = Array.from(pages)
              .flatMap((page) => page.assessmentMetadata ?? [])
              .flatMap((assessment) => (assessment.id ? [assessment.id] : []));
            const hydrated = yield* Effect.forEach(
              ids,
              (assessmentId) => readAssessmentById(assessmentId),
              { concurrency: 5 },
            );
            return hydrated.flatMap((assessment) =>
              assessment === undefined ? [] : [toAttributes(assessment)],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const assessment = output?.assessmentId
            ? yield* readAssessmentById(output.assessmentId)
            : yield* findAssessmentByName(
                yield* createAssessmentName(id, olds ?? {}),
              );
          if (!assessment) return undefined;
          const attrs = toAttributes(assessment);
          return (yield* hasAlchemyTags(id, attrs.tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The source framework is fixed at creation.
          if (olds.frameworkId !== news.frameworkId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = yield* createAssessmentName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredScope: AssessmentScope = news.scope ?? {
            awsAccounts: [{ id: accountId }],
          };
          const desiredDestination = {
            destinationType:
              news.assessmentReportsDestination.destinationType ?? "S3",
            destination: news.assessmentReportsDestination.destination,
          };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let assessment = output?.assessmentId
            ? yield* readAssessmentById(output.assessmentId)
            : yield* findAssessmentByName(name);

          // Ensure — create if missing.
          if (assessment === undefined) {
            const created = yield* retryThroughIamPropagation(
              auditmanager.createAssessment({
                name,
                description: news.description,
                frameworkId: news.frameworkId,
                assessmentReportsDestination: desiredDestination,
                scope: desiredScope,
                roles: news.roles,
                tags: desiredTags,
              }),
            );
            assessment = created.assessment;
            if (!assessment?.metadata?.id) {
              return yield* Effect.fail(
                new Error(
                  `CreateAssessment for '${name}' returned no assessment`,
                ),
              );
            }
            yield* session.note(
              `Created assessment ${name} (${assessment.metadata.id})`,
            );
          }

          // Sync — diff observed against desired; update on drift.
          const metadata = assessment.metadata;
          const observed = projectAssessment({
            name: unredact(metadata?.name) ?? "",
            description: unredact(metadata?.description) ?? "",
            destinationType:
              metadata?.assessmentReportsDestination?.destinationType ?? "S3",
            destination:
              metadata?.assessmentReportsDestination?.destination ?? "",
            accountIds: (metadata?.scope?.awsAccounts ?? []).flatMap(
              (account) => (account.id ? [account.id] : []),
            ),
            serviceNames: (metadata?.scope?.awsServices ?? []).flatMap(
              (service) => (service.serviceName ? [service.serviceName] : []),
            ),
            roles: (metadata?.roles ?? []).map((role) => ({
              roleType: role.roleType,
              roleArn: role.roleArn,
            })),
          });
          const desired = projectAssessment({
            name,
            description: news.description ?? "",
            destinationType: desiredDestination.destinationType,
            destination: desiredDestination.destination,
            accountIds: (desiredScope.awsAccounts ?? []).map(
              (account) => account.id,
            ),
            serviceNames: (desiredScope.awsServices ?? []).map(
              (service) => service.serviceName,
            ),
            roles: news.roles.map((role) => ({
              roleType: role.roleType,
              roleArn: role.roleArn,
            })),
          });
          // Audit Manager expands an accounts-only scope with the services it
          // detects, so only compare services the user explicitly pinned.
          const serviceDrifted =
            news.scope?.awsServices !== undefined &&
            JSON.stringify(observed.serviceNames) !==
              JSON.stringify(desired.serviceNames);
          const drifted =
            observed.name !== desired.name ||
            observed.description !== desired.description ||
            observed.destinationType !== desired.destinationType ||
            observed.destination !== desired.destination ||
            JSON.stringify(observed.accountIds) !==
              JSON.stringify(desired.accountIds) ||
            JSON.stringify(observed.roles) !== JSON.stringify(desired.roles) ||
            serviceDrifted;
          const assessmentId = metadata?.id ?? output?.assessmentId ?? "";
          if (drifted) {
            const updated = yield* retryThroughIamPropagation(
              auditmanager.updateAssessment({
                assessmentId,
                assessmentName: name,
                assessmentDescription: news.description,
                scope: desiredScope,
                assessmentReportsDestination: desiredDestination,
                roles: news.roles,
              }),
            );
            assessment = updated.assessment ?? assessment;
            yield* session.note(`Updated assessment ${name}`);
          }

          // Sync tags — diff against observed cloud tags.
          const attrs = toAttributes(assessment);
          const { removed, upsert } = diffTags(attrs.tags, desiredTags);
          if (removed.length > 0) {
            yield* auditmanager.untagResource({
              resourceArn: attrs.arn,
              tagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* auditmanager.tagResource({
              resourceArn: attrs.arn,
              tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
          }

          yield* session.note(attrs.arn);
          return { ...attrs, tags: desiredTags };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* auditmanager
            .deleteAssessment({ assessmentId: output.assessmentId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
