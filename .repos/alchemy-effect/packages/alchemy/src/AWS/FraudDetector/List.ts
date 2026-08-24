import * as frauddetector from "@distilled.cloud/aws/frauddetector";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readFraudDetectorTags, syncFraudDetectorTags } from "./internal.ts";

export interface ListProps {
  /**
   * Name of the list. If omitted, a unique lowercase name is generated from
   * the app, stage, and logical ID. Changing the name replaces the list.
   */
  name?: string;
  /**
   * Human-readable description. This is an in-place update.
   */
  description?: string;
  /**
   * The variable type of the list's elements (e.g. `IP_ADDRESS`,
   * `EMAIL_ADDRESS`). Fraud Detector only allows setting the variable type
   * once — changing an already-set variable type replaces the list.
   */
  variableType?: string;
  /**
   * The elements of the list. Reconcile converges the live list to exactly
   * this set (a `REPLACE` update); elements appended out-of-band (e.g. via the
   * `UpdateList` runtime binding) are removed on the next deploy unless they
   * are added here.
   *
   * @default []
   */
  elements?: string[];
  /**
   * User-defined tags for the list.
   */
  tags?: Record<string, string>;
}

export interface List extends Resource<
  "AWS.FraudDetector.List",
  ListProps,
  {
    /** The name of the list. */
    name: string;
    /** The ARN of the list. */
    arn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Fraud Detector list — a set of input values for a variable (an
 * allow-list or deny-list, e.g. known-fraud IP addresses) referenced from
 * detector rule expressions.
 *
 * @resource
 * @section Creating a List
 * @example Deny-list of IP Addresses
 * ```typescript
 * const blockedIps = yield* FraudDetector.List("BlockedIps", {
 *   variableType: "IP_ADDRESS",
 *   description: "known-fraud source addresses",
 *   elements: ["203.0.113.7", "198.51.100.9"],
 * });
 * ```
 *
 * @section Using a List at Runtime
 * @example Append to the List from a Lambda
 * ```typescript
 * // init
 * const updateList = yield* FraudDetector.UpdateList(blockedIps);
 * const getListElements = yield* FraudDetector.GetListElements(blockedIps);
 *
 * // runtime
 * yield* updateList({ elements: ["192.0.2.44"], updateMode: "APPEND" });
 * const { elements } = yield* getListElements({});
 * // on the Function effect:
 * // .pipe(Effect.provide(Layer.mergeAll(
 * //   FraudDetector.UpdateListHttp,
 * //   FraudDetector.GetListElementsHttp,
 * // )))
 * ```
 */
export const List = Resource<List>("AWS.FraudDetector.List");

/** Coerce a distilled sensitive element (`string | Redacted<string>`) to a plain string. */
const toElement = (e: string | Redacted.Redacted<string>): string =>
  typeof e === "string" ? e : Redacted.value(e);

export const ListProvider = () =>
  Provider.effect(
    List,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: ListProps) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 64, lowercase: true }))
        );
      });

      /** Look a list's metadata up by name; typed not-found → undefined. */
      const get = Effect.fn(function* (name: string) {
        const response = yield* frauddetector
          .getListsMetadata({ name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.lists?.find((list) => list.name === name);
      });

      /** Read the full (paginated) element set of a list. */
      const getElements = Effect.fn(function* (name: string) {
        const pages = yield* frauddetector.getListElements
          .pages({ name })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          (page.elements ?? []).map(toElement),
        );
      });

      const toAttrs = (list: frauddetector.AllowDenyList) => ({
        name: list.name,
        arn: list.arn!,
      });

      return {
        stables: ["name", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            // The variable type can only be set once — changing an
            // already-set variable type requires a replacement.
            (olds.variableType !== undefined &&
              news.variableType !== olds.variableType)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const list = yield* get(name);
          if (list === undefined) return undefined;
          const attrs = toAttrs(list);
          const tags = yield* readFraudDetectorTags(list.arn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredElements = news.elements ?? [];

          // Observe — the live list is authoritative.
          let list = yield* get(name);

          if (list === undefined) {
            // Ensure — greenfield create carries the full desired state.
            yield* frauddetector.createList({
              name,
              description: news.description,
              variableType: news.variableType,
              elements: desiredElements,
              tags: Object.entries(desiredTags).map(([key, value]) => ({
                key,
                value,
              })),
            });
            list = yield* get(name);
          } else {
            // Sync — diff each mutable aspect against OBSERVED state and send
            // only the delta.
            const observedElements = yield* getElements(name);
            const desiredSet = new Set(desiredElements);
            const observedSet = new Set(observedElements);
            const elementsChanged =
              desiredSet.size !== observedSet.size ||
              Array.from(desiredSet).some((e) => !observedSet.has(e));
            const descriptionChanged =
              (news.description ?? undefined) !==
              (list.description ?? undefined);
            // The variable type can only be introduced, never changed (a
            // change is a replacement, handled by diff above).
            const variableTypeIntroduced =
              list.variableType === undefined &&
              news.variableType !== undefined;

            if (
              elementsChanged ||
              descriptionChanged ||
              variableTypeIntroduced
            ) {
              yield* frauddetector.updateList({
                name,
                ...(elementsChanged
                  ? { elements: desiredElements, updateMode: "REPLACE" }
                  : {}),
                ...(descriptionChanged
                  ? { description: news.description }
                  : {}),
                ...(variableTypeIntroduced
                  ? { variableType: news.variableType }
                  : {}),
              });
              list = yield* get(name);
            }
          }

          // Sync tags — diff against OBSERVED cloud tags.
          yield* syncFraudDetectorTags(list!.arn!, desiredTags);

          yield* session.note(name);
          return toAttrs(list!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* frauddetector.deleteList({ name: output.name }).pipe(
            // Deleting an already-removed list is a no-op for us; Fraud
            // Detector surfaces a missing list as a validation error.
            Effect.catchTag("ValidationException", () => Effect.void),
          );
        }),

        list: () =>
          frauddetector.getListsMetadata.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.lists ?? []).map(toAttrs),
              ),
            ),
          ),
      };
    }),
  );
