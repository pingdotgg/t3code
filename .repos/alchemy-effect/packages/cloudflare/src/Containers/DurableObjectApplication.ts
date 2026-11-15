import * as Containers from "@distilled.cloud/cloudflare/containers";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Namespace from "alchemy/Namespace";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import { normalizeNulls } from "alchemy/Util/stable";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import { generateLocalId, isLiveId } from "../LocalRuntime.ts";
import type { Providers } from "../Providers.ts";
import type { DurableObjectApplicationSettings } from "./ContainerApplication.ts";
import { createContainerApplicationName } from "./ContainerBundle.ts";
import {
  ContainerConfigurationError,
  durableObjectSettingsPatch,
  mergeApplicationSettings,
} from "./ContainerConfiguration.ts";

export const DurableObjectApplicationTypeId = "Cloudflare.Containers.DurableObjectApplication";

export interface DurableObjectApplicationProps {
  /** The Durable Object class whose namespace the application serves. */
  className: string;
}

/** What each bound Container contributes to its class's application. */
export interface DurableObjectApplicationBinding {
  /** The Durable Object namespace the application is attached to. */
  durableObjects?: { namespaceId: string };
  /** The bound Container and the application-wide settings it declares. */
  container?: { id: string; settings: DurableObjectApplicationSettings };
}

/**
 * INTERNAL — the one container application of a Durable Object class.
 *
 * Cloudflare allows exactly one container application per Durable Object
 * namespace. Every `schedulingPolicy: "durable_object"` Container bound to a
 * class declares this resource under the same logical id, so the engine
 * registers it once; each Container then binds its application-wide settings
 * onto it. The images themselves are Worker upload metadata, merged by the
 * Worker.
 *
 * @internal
 */
export interface DurableObjectApplication extends Resource<
  typeof DurableObjectApplicationTypeId,
  DurableObjectApplicationProps,
  {
    /** The application id, which equals the Durable Object namespace id. Empty before creation. */
    applicationId: string;
    /** The generated application name. */
    applicationName: string;
    /** The Cloudflare account that owns the application. */
    accountId: string;
    /** The Durable Object class the application serves. */
    className: string;
    /** The Durable Object namespace attached to the application. */
    durableObjects: { namespaceId: string } | undefined;
    /** ISO-8601 creation time. Empty before creation. */
    createdAt: string;
    /** Application-wide container configuration (SSH and authorized keys). */
    configuration: Containers.DurableObjectContainerConfiguration;
    /** Application-wide logging. */
    observability: Containers.ContainerApplicationObservability | undefined;
    /** The merged settings last applied, used to reset settings a Container stops declaring. */
    settings: DurableObjectApplicationSettings;
  },
  DurableObjectApplicationBinding,
  Providers
> {}

export const DurableObjectApplication = Resource<DurableObjectApplication>(
  DurableObjectApplicationTypeId,
);

/**
 * Declare the container application of `className`, hosted by `worker`. Every
 * Container bound to the class calls this; the engine dedupes the declaration
 * by its fully qualified id, so all of them share one resource.
 */
export const declareDurableObjectApplication = (worker: { LogicalId: string }, className: string) =>
  Namespace.push(
    worker.LogicalId,
    DurableObjectApplication(`${className}-Containers`, { className }),
  );

/**
 * Right after a Worker upload creates a Durable Object namespace, the
 * containers API can report the namespace missing for a few seconds before it
 * sees it. Retry creates that attach to it, bounded at ~30s.
 */
export const retryNamespacePropagation = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "DurableObjectNamespaceNotFound"
        ? Effect.logDebug("Cloudflare Container create: namespace not visible yet, retrying")
        : Effect.void,
    ),
    Effect.retry({
      // Cloudflare also refuses creates for a moment ("can't create
      // application at this time"); the same request succeeds when retried.
      while: (error) =>
        error._tag === "DurableObjectNamespaceNotFound" ||
        error._tag === "ContainerApplicationCreateUnavailable",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

/** Whether an application id names a created, live application (not a placeholder). */
const isLiveApplication = (id: string | undefined): id is string => !!id && isLiveId(id);

type Bindings = ReadonlyArray<ResourceBinding<DurableObjectApplicationBinding>>;

/** The one namespace every bound Container attaches the application to. */
const boundNamespace = (className: string, bindings: Bindings) => {
  // A stale Worker namespace map can resolve a binding without an id; it
  // does not request removing the live attachment.
  const ids = [
    ...new Set(
      bindings.flatMap((b) =>
        b.data.durableObjects?.namespaceId ? [b.data.durableObjects.namespaceId] : [],
      ),
    ),
  ];
  if (ids.length > 1) {
    return Effect.fail(
      new ContainerConfigurationError({
        message: `The container application of Durable Object class '${className}' is bound to ${ids.length} namespaces (${ids.join(", ")}). A class has one namespace.`,
      }),
    );
  }
  return Effect.succeed(ids[0] === undefined ? undefined : { namespaceId: ids[0] });
};

const boundSettings = (className: string, bindings: Bindings) =>
  mergeApplicationSettings(
    className,
    bindings.flatMap((b) => (b.data.container ? [b.data.container] : [])),
  );

/**
 * Check the bound settings for conflicts at plan time. The namespace id in
 * the same bindings resolves only after the Worker uploads, so check the
 * settings contributions on their own once they are resolved.
 */
const planSettings = (className: string, newBindings: unknown) => {
  const contributions = (Array.isArray(newBindings) ? newBindings : []).flatMap(
    (binding: { data?: DurableObjectApplicationBinding }) =>
      binding?.data?.container ? [binding.data.container] : [],
  );
  return isResolved(contributions)
    ? Effect.asVoid(mergeApplicationSettings(className, contributions))
    : Effect.void;
};

const placeholder = (
  identity: Pick<
    DurableObjectApplication["Attributes"],
    "applicationId" | "applicationName" | "accountId" | "className" | "createdAt"
  > &
    Partial<DurableObjectApplication["Attributes"]>,
): DurableObjectApplication["Attributes"] => ({
  durableObjects: undefined,
  configuration: {},
  observability: undefined,
  settings: {},
  ...identity,
});

const toAttributes = (
  application: Containers.GetContainerApplicationResponse,
  className: string,
  settings: DurableObjectApplicationSettings,
): DurableObjectApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  className,
  durableObjects: normalizeNulls(application.durableObjects) as { namespaceId: string } | undefined,
  createdAt: application.createdAt,
  configuration: normalizeNulls(
    application.configuration,
  ) as Containers.DurableObjectContainerConfiguration,
  observability: normalizeNulls(application.observability ?? undefined),
  settings,
});

export const LiveDurableObjectApplicationProvider = () =>
  Provider.succeed(DurableObjectApplication, {
    stables: ["accountId", "className"],
    diff: Effect.fn(function* ({ news, output, newBindings }) {
      if (!isResolved(news)) return undefined;
      // Conflicting settings fail the plan, before anything is published.
      yield* planSettings(news.className, newBindings);
      if (!isResolved(newBindings)) return undefined;
      const namespace = yield* boundNamespace(news.className, newBindings);
      const deployed = output?.durableObjects?.namespaceId;
      if (deployed !== undefined && namespace !== undefined && deployed !== namespace.namespaceId) {
        return yield* new ContainerConfigurationError({
          message: `The container application of Durable Object class '${news.className}' cannot move to another Durable Object namespace.`,
        });
      }
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (
        output !== undefined &&
        isLiveApplication(output.applicationId) &&
        output.accountId !== accountId
      ) {
        return yield* new ContainerConfigurationError({
          message: `The container application of Durable Object class '${news.className}' cannot move to another account in place.`,
        });
      }
      // Precreate only reserves a name; reconcile creates the application
      // once the Worker has created its namespace.
      if (!isLiveApplication(output?.applicationId)) {
        return { action: "update", stables: ["accountId", "className"] } as const;
      }
      return undefined;
    }),
    precreate: Effect.fn(function* ({ id, news, bindings }) {
      // A new application is never diffed; fail conflicting settings here,
      // before the Worker is uploaded.
      yield* planSettings(news.className, bindings);
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The application needs the Worker's namespace id, which does not exist
      // yet. Reserve the name so the Worker's upload can reference it.
      return placeholder({
        applicationId: "",
        applicationName: yield* createContainerApplicationName(id, undefined),
        accountId,
        className: news.className,
        createdAt: "",
      });
    }),
    reconcile: Effect.fn(function* ({ id, news, bindings, output, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const className = news.className;
      // Prefer the deployed name: regenerating would target a different
      // application if the generator's output for this id ever drifts.
      const name =
        output?.applicationName || (yield* createContainerApplicationName(id, undefined));
      const durableObjects =
        (yield* boundNamespace(className, bindings)) ??
        (output?.durableObjects?.namespaceId ? output.durableObjects : undefined);
      if (!durableObjects) {
        // An existing Worker gaining this class publishes its old output
        // first, which has no namespace for it yet. The application stays a
        // placeholder until the Worker's upload binds the namespace, when
        // the run reconciles it again; if that never comes, the next
        // deploy's diff plans the create.
        if (!isLiveApplication(output?.applicationId)) {
          return placeholder({
            applicationId: "",
            applicationName: name,
            accountId,
            className,
            createdAt: "",
          });
        }
        return yield* new ContainerConfigurationError({
          message: `The container application of Durable Object class '${className}' requires a resolved Durable Object namespace. Reconcile its Worker first.`,
        });
      }
      const settings = yield* boundSettings(className, bindings);

      // The application's id is the id of the namespace it serves.
      const applicationId = durableObjects.namespaceId;
      const getApplication = Containers.getContainerApplication({ accountId, applicationId });
      const assertServesNamespace = (application: Containers.GetContainerApplicationResponse) =>
        application.schedulingPolicy === "durable_object" &&
        application.durableObjects?.namespaceId === applicationId
          ? Effect.void
          : Effect.fail(
              new ContainerConfigurationError({
                message: `The container application '${application.name}' of Durable Object namespace '${applicationId}' is not Durable Object-managed. Declare a new Durable Object class for Durable Object-managed Containers.`,
              }),
            );

      // 1. Observe. The namespace belongs to this stack's Worker, so an
      //    application already attached to it is this class's application.
      let application = yield* getApplication.pipe(
        Effect.catchTag("ContainerApplicationNotFound", () => Effect.undefined),
      );

      // 2. Ensure
      if (!application) {
        yield* session.note(`Creating container application ${name}...`);
        application = yield* retryNamespacePropagation(
          Containers.createDurableObjectContainerApplication({
            accountId,
            name,
            schedulingPolicy: "durable_object",
            durableObjects,
            configuration: {
              ...(settings.ssh !== undefined ? { wranglerSsh: settings.ssh } : {}),
              ...(settings.authorizedKeys !== undefined
                ? { authorizedKeys: settings.authorizedKeys }
                : {}),
            },
            observability: settings.observability,
          }),
        ).pipe(Effect.catchTag("DurableObjectAlreadyHasApplication", () => getApplication));
      }
      yield* assertServesNamespace(application);

      // 3. Sync declared settings and reset settings no Container declares anymore.
      const patch = durableObjectSettingsPatch(settings, output?.settings, application);
      if (patch.configuration !== undefined || patch.observability !== undefined) {
        application = yield* Containers.updateContainerApplication({
          accountId,
          applicationId,
          ...patch,
        });
      }
      return toAttributes(application, className, settings);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (!isLiveApplication(output.applicationId)) return;
      yield* Containers.deleteContainerApplication({
        accountId: output.accountId,
        applicationId: output.applicationId,
      }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.void));
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const className = olds?.className ?? output?.className ?? "";
      if (output !== undefined && isLiveApplication(output.applicationId)) {
        return yield* Containers.getContainerApplication({
          accountId: output.accountId,
          applicationId: output.applicationId,
        }).pipe(
          Effect.map((application) => toAttributes(application, className, output.settings)),
          Effect.catchTag("ContainerApplicationNotFound", () => Effect.undefined),
        );
      }
      // Generated names identify this instance, so a match is ours.
      const name =
        output?.applicationName || (yield* createContainerApplicationName(id, undefined));
      const found = yield* Containers.listContainerApplications({ accountId }).pipe(
        Effect.map((apps) =>
          apps.find((app) => app.name === name && app.schedulingPolicy === "durable_object"),
        ),
      );
      return found === undefined
        ? undefined
        : toAttributes(found, className, output?.settings ?? {});
    }),
  });

/**
 * Local (dev) provider: `alchemy dev` runs every image through workerd and
 * Docker, so the application is a placeholder carrying a `dev:` id.
 */
export const LocalDurableObjectApplicationProvider = () =>
  Provider.succeed(DurableObjectApplication, {
    stables: ["accountId", "className"],
    diff: Effect.fn(function* ({ news, newBindings }) {
      if (!isResolved(news)) return undefined;
      yield* planSettings(news.className, newBindings);
      return undefined;
    }),
    precreate: Effect.fn(function* ({ id, news, bindings }) {
      yield* planSettings(news.className, bindings);
      return placeholder({
        applicationId: generateLocalId(),
        applicationName: yield* createContainerApplicationName(id, undefined),
        accountId: yield* localAccountId,
        className: news.className,
        createdAt: new Date().toISOString(),
      });
    }),
    reconcile: Effect.fn(function* ({ id, news, bindings, output }) {
      return placeholder({
        applicationId: output?.applicationId || generateLocalId(),
        applicationName: yield* createContainerApplicationName(id, undefined),
        accountId: yield* localAccountId,
        className: news.className,
        createdAt: output?.createdAt || new Date().toISOString(),
        durableObjects: yield* boundNamespace(news.className, bindings),
        settings: yield* boundSettings(news.className, bindings),
      });
    }),
    delete: () => Effect.void,
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
  });

export const DurableObjectApplicationProvider = () =>
  ProviderLayer.dual(DurableObjectApplication, {
    live: () => LiveDurableObjectApplicationProvider(),
    local: () => LocalDurableObjectApplicationProvider(),
  });
