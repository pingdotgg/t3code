import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord, unredact } from "./internal.ts";

/**
 * A control referenced by a framework control set.
 */
export interface FrameworkControl {
  /**
   * The unique identifier of the control (standard or custom).
   */
  id: string;
}

/**
 * A grouping of related controls within a framework.
 */
export interface FrameworkControlSet {
  /**
   * Name of the control set.
   */
  name: string;
  /**
   * The controls in the set, referenced by control id.
   */
  controls?: FrameworkControl[];
}

export interface FrameworkProps {
  /**
   * Name of the custom framework.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * A description of the framework.
   */
  description?: string;
  /**
   * The compliance standard the framework relates to (e.g. `CIS`, `HIPAA`).
   */
  complianceType?: string;
  /**
   * The control sets that make up the framework. At least one set with at
   * least one control is required.
   */
  controlSets: FrameworkControlSet[];
  /**
   * Tags to associate with the framework.
   */
  tags?: Record<string, string>;
}

export interface Framework extends Resource<
  "AWS.AuditManager.Framework",
  FrameworkProps,
  {
    /**
     * Service-assigned unique identifier of the framework.
     */
    frameworkId: string;
    /**
     * ARN of the framework.
     */
    arn: string;
    /**
     * The framework's name.
     */
    name: string;
    /**
     * The framework's type — always `Custom` for frameworks Alchemy creates.
     */
    type: auditmanager.FrameworkType | undefined;
    /**
     * Current tags reported for the framework.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A custom assessment framework in AWS Audit Manager — a named collection
 * of control sets that assessments are created from.
 *
 * :::note
 * Audit Manager must be registered in the account (`RegisterAccount`)
 * before frameworks can be created.
 * :::
 * @resource
 * @section Creating Frameworks
 * @example Framework from a Custom Control
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const control = yield* AWS.AuditManager.Control("AccessReview", {
 *   controlMappingSources: [{
 *     sourceName: "access-review-records",
 *     sourceSetUpOption: "Procedural_Controls_Mapping",
 *     sourceType: "MANUAL",
 *   }],
 * });
 *
 * const framework = yield* AWS.AuditManager.Framework("Compliance", {
 *   description: "Internal compliance framework",
 *   controlSets: [{
 *     name: "Access Management",
 *     controls: [{ id: control.controlId }],
 *   }],
 * });
 * ```
 */
export const Framework = Resource<Framework>("AWS.AuditManager.Framework");

const createFrameworkName = (
  id: string,
  props: { name?: string | undefined },
) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 100 });

const toAttributes = (
  framework: auditmanager.Framework,
): Framework["Attributes"] => ({
  frameworkId: framework.id ?? "",
  arn: framework.arn ?? "",
  name: framework.name ?? "",
  type: framework.type,
  tags: toTagRecord(framework.tags),
});

const readFrameworkById = Effect.fn(function* (frameworkId: string) {
  const response = yield* auditmanager
    .getAssessmentFramework({ frameworkId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  return response?.framework;
});

const findFrameworkByName = Effect.fn(function* (name: string) {
  const pages = yield* auditmanager.listAssessmentFrameworks
    .pages({ frameworkType: "Custom" })
    .pipe(EffectStream.runCollect);
  const match = Array.from(pages)
    .flatMap((page) => page.frameworkMetadataList ?? [])
    .find((framework) => framework.name === name);
  if (!match?.id) return undefined;
  return yield* readFrameworkById(match.id);
});

/**
 * Projection used for drift detection — control set names with their sorted
 * control ids.
 */
const projectControlSets = (
  controlSets: {
    name?: string | undefined;
    controls?: { id?: string | undefined }[] | undefined;
  }[],
) =>
  controlSets.map((set) => ({
    name: set.name ?? "",
    controls: (set.controls ?? [])
      .flatMap((control) => (control.id ? [control.id] : []))
      .sort(),
  }));

export const FrameworkProvider = () =>
  Provider.effect(
    Framework,
    Effect.gen(function* () {
      return {
        stables: ["frameworkId", "arn"],
        list: () =>
          Effect.gen(function* () {
            const pages = yield* auditmanager.listAssessmentFrameworks
              .pages({ frameworkType: "Custom" })
              .pipe(EffectStream.runCollect);
            const ids = Array.from(pages)
              .flatMap((page) => page.frameworkMetadataList ?? [])
              .flatMap((framework) => (framework.id ? [framework.id] : []));
            const hydrated = yield* Effect.forEach(
              ids,
              (frameworkId) => readFrameworkById(frameworkId),
              { concurrency: 5 },
            );
            return hydrated.flatMap((framework) =>
              framework === undefined ? [] : [toAttributes(framework)],
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const framework = output?.frameworkId
            ? yield* readFrameworkById(output.frameworkId)
            : yield* findFrameworkByName(
                yield* createFrameworkName(id, olds ?? {}),
              );
          if (!framework) return undefined;
          const attrs = toAttributes(framework);
          return (yield* hasAlchemyTags(id, attrs.tags as Tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createFrameworkName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the cached id; fall back to a name lookup so a
          // create whose state failed to persist is adopted, not duplicated.
          let framework = output?.frameworkId
            ? yield* readFrameworkById(output.frameworkId)
            : yield* findFrameworkByName(name);

          // Ensure — create if missing.
          if (framework === undefined) {
            const created = yield* auditmanager.createAssessmentFramework({
              name,
              description: news.description,
              complianceType: news.complianceType,
              controlSets: news.controlSets,
              tags: desiredTags,
            });
            framework = created.framework;
            if (!framework?.id) {
              return yield* Effect.fail(
                new Error(
                  `CreateAssessmentFramework for '${name}' returned no framework`,
                ),
              );
            }
            yield* session.note(`Created framework ${name} (${framework.id})`);
          }

          // Sync — diff observed against desired; update on drift.
          const drifted =
            (framework.name ?? "") !== name ||
            (framework.description ?? "") !== (news.description ?? "") ||
            (unredact(framework.complianceType) ?? "") !==
              (news.complianceType ?? "") ||
            JSON.stringify(projectControlSets(framework.controlSets ?? [])) !==
              JSON.stringify(projectControlSets(news.controlSets));
          if (drifted) {
            // Reuse the server-assigned control set id for sets whose name is
            // unchanged so AWS updates them in place instead of replacing.
            const observedByName = new Map(
              (framework.controlSets ?? []).map((set) => [set.name, set.id]),
            );
            const updated = yield* auditmanager.updateAssessmentFramework({
              frameworkId: framework.id ?? "",
              name,
              description: news.description,
              complianceType: news.complianceType,
              controlSets: news.controlSets.map((set) => ({
                id: observedByName.get(set.name),
                name: set.name,
                controls: set.controls ?? [],
              })),
            });
            framework = updated.framework ?? framework;
            yield* session.note(`Updated framework ${name}`);
          }

          // Sync tags — diff against observed cloud tags.
          const attrs = toAttributes(framework);
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
            .deleteAssessmentFramework({ frameworkId: output.frameworkId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );
