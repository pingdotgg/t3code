import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  collectPages,
  expandName,
  fieldMask,
  fingerprint,
  forEachRepository,
  hasTargetUriOwnership,
  normalizeLocation,
  PAGE_SIZE,
  parseName,
  parseTargetUriOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  retryConflict,
  rfc1035,
  sameText,
  stripAlchemyQuery,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type HookEvent = ssm.HookEventsItemEnum | (string & {});

export type RepositoriesHookProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the hook.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Hook id (the `{hook}` segment). If omitted, a unique RFC1035 name is
   * generated. Immutable — changing it replaces the hook.
   */
  hookId?: string;
  /**
   * Target URI that receives webhook payloads, sent as given. Hooks have
   * no labels, so ownership rests on the hook id (generated ids embed the
   * stack, stage, and logical id).
   */
  targetUri: string;
  /**
   * Events that fire the hook (`PUSH`, `PULL_REQUEST`).
   */
  events?: HookEvent[];
  /**
   * When true, the hook exists but does not send traffic.
   * @default false
   */
  disabled?: boolean;
  /**
   * Sensitive query string appended to `targetUri` by the service.
   */
  sensitiveQueryString?: string;
  /**
   * Push-event filter. Empty or `*` reports every branch.
   */
  pushOption?: {
    /** Glob of branches that trigger the hook. */
    branchFilter?: string;
  };
};

export type RepositoriesHook = Resource<
  "GCP.SecureSourceManager.RepositoriesHook",
  RepositoriesHookProps,
  {
    /** Full resource name. */
    name: string;
    /** Hook id (last path segment). */
    hookId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Target URI with Alchemy ownership query parameters stripped. */
    targetUri: string;
    /** Events that fire the hook. */
    events: HookEvent[];
    /** Whether the hook is disabled. */
    disabled: boolean;
    /** Push-event filter. */
    pushOption:
      | {
          branchFilter: string | undefined;
        }
      | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Secure Source Manager repository webhook.
 *
 * Changing `hookId`, `repository`, or `location` replaces the hook.
 * Target URI, events, disabled flag, and push options update in place.
 * Ownership for `list` / nuke is stamped into `targetUri` query
 * parameters (hooks have no labels field).
 *
 * ### Creating a Hook
 * **Example:** Push webhook
 * ```typescript
 * const hook = yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
 *   repository: repo.name,
 *   targetUri: "https://example.com/hooks/ssm",
 *   events: ["PUSH"],
 * });
 * ```
 *
 * **Example:** Named hook with a branch filter
 * ```typescript
 * const hook = yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
 *   repository: repo.name,
 *   hookId: "prod-push",
 *   targetUri: "https://example.com/hooks/ssm",
 *   events: ["PUSH", "PULL_REQUEST"],
 *   pushOption: { branchFilter: "main" },
 * });
 * ```
 *
 * ### Updating a Hook
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Disable and retarget
 * ```typescript
 * const hook = yield* GCP.SecureSourceManager.RepositoriesHook("Notify", {
 *   repository: repo.name,
 *   targetUri: "https://example.com/hooks/ssm-v2",
 *   events: ["PUSH"],
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 * @category SecureSourceManager
 */
export const RepositoriesHook = Resource<RepositoriesHook>(
  "GCP.SecureSourceManager.RepositoriesHook",
);

const resourceName = (repository: string, hookId: string) =>
  `${repository}/hooks/${hookId}`;

const toEvents = (
  events: readonly (ssm.HookEventsItemEnum | (string & {}))[] | undefined,
): HookEvent[] => [...(events ?? [])].slice().sort();

const toAttrs = (item: ssm.Hook, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "hooks", region);
  return {
    name,
    hookId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    targetUri: stripAlchemyQuery(item.targetUri ?? ""),
    events: toEvents(item.events),
    disabled: item.disabled === true,
    pushOption:
      item.pushOption === undefined
        ? undefined
        : { branchFilter: item.pushOption.branchFilter },
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(ssm.getProjectsLocationsRepositoriesHooks({ name }));

const listOnRepository = (repository: string) =>
  collectPages(
    ssm.listProjectsLocationsRepositoriesHooks.pages({
      parent: repository,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.hooks,
  );

const listOwned = (project: string, region: string) =>
  forEachRepository(project, region, (repository) =>
    listOnRepository(repository).pipe(
      Effect.map((items) =>
        items.filter((item) => hasTargetUriOwnership(item.targetUri)),
      ),
    ),
  );

export const RepositoriesHookProvider = () =>
  Provider.succeed(RepositoriesHook, {
    stables: [
      "name",
      "hookId",
      "repository",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.hookId ?? output?.hookId,
        nextId: news.hookId
          ? rfc1035(news.hookId, "hook")
          : (olds?.hookId ?? output?.hookId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandName(
          news.repository,
          env.project,
          location,
          "repositories",
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const hookId = yield* toPhysicalId(
        id,
        olds?.hookId,
        output?.hookId,
        "hook",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const repository = expandName(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
        "repositories",
      );
      const name =
        output?.name ??
        (repository.length > 0 ? resourceName(repository, hookId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // A generated id embeds stack/stage/logical id, so finding it means we
      // created it; an explicit id could name anyone's hook. Hooks created
      // before ownership moved off the URI still carry query markers.
      const owned =
        output !== undefined ||
        olds?.hookId === undefined ||
        (yield* hasAlchemyLabels(
          id,
          parseTargetUriOwnership(existing.targetUri),
        ));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item: ssm.Hook) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const hookId = yield* toPhysicalId(
        id,
        news.hookId,
        output?.hookId,
        "hook",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const repository = expandName(
        news.repository,
        env.project,
        location,
        "repositories",
      );
      const name = resourceName(repository, hookId);
      const targetUri = news.targetUri;
      const events = toEvents(news.events);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* ssm
          .createProjectsLocationsRepositoriesHooks({
            parent: repository,
            hookId,
            body: {
              targetUri,
              events: events.length > 0 ? events : undefined,
              disabled: news.disabled === true ? true : undefined,
              sensitiveQueryString: news.sensitiveQueryString,
              pushOption: news.pushOption,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const mask = fieldMask([
        !sameText(current.targetUri, targetUri) && "targetUri",
        fingerprint(toEvents(current.events)) !== fingerprint(events) &&
          "events",
        (current.disabled === true) !== (news.disabled === true) && "disabled",
        !sameText(current.sensitiveQueryString, news.sensitiveQueryString) &&
          "sensitiveQueryString",
        fingerprint(current.pushOption) !== fingerprint(news.pushOption) &&
          "pushOption",
      ]);

      if (mask.length > 0) {
        const operation = yield* ssm.patchProjectsLocationsRepositoriesHooks({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            targetUri,
            events,
            disabled: news.disabled === true,
            sensitiveQueryString: news.sensitiveQueryString,
            pushOption: news.pushOption,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryConflict(
        ssm
          .deleteProjectsLocationsRepositoriesHooks({ name: output.name })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
