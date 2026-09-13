import { loadInternalWorker } from "../../internal/internal-worker.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
const WorkflowsBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/workflows/binding.worker",
    ),
};
const WorkflowsWrappedBindingWorker = {
  worker: () =>
    loadInternalWorker(
      "#cloudflare-runtime-core-worker/bindings/workflows/wrapped-binding.worker",
    ),
};
import * as Storage from "../../globals/Storage.ts";
import { SERVICE_USER_WORKER } from "../../internal/constants.ts";
import {
  formatExtensionModule,
  formatInternalWorkerModules,
} from "../../internal/internal-modules.ts";
import type { BindingHook } from "../../PluginContext.ts";
import { PluginContext } from "../../PluginContext.ts";
import * as Plugin from "../../Plugin.ts";
import { RegistryProxy } from "../../registry/RegistryProxy.ts";
import { makeRemoteBinding } from "../../remote-bindings/RemoteBindings.ts";
import { ConfigError } from "../../RuntimeError.shared.ts";
import type { Workflow } from "../../RuntimeWorker.ts";
import type * as WorkerdConfig from "../../workerd/Config.ts";

const WORKFLOWS_WRAPPED_BINDING_MODULE =
  "cloudflare-runtime:workflows-wrapped-binding";
const WORKFLOWS_STORAGE_SERVICE_NAME = "workflows:storage";

export class Workflows extends Plugin.Service<Workflows>()(
  "cloudflare-runtime/plugin/Workflows",
) {}

export const WorkflowsLive = Layer.effect(
  Workflows,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;

    const makeStorageService = Effect.gen(function* () {
      const storageDiskPath =
        "disk" in storage ? storage.disk?.path : undefined;
      if (!storageDiskPath) {
        return yield* new ConfigError({
          subtag: "Workflows",
          message:
            "Cannot configure workflows persistence: the Storage service has no disk path.",
          hint: "Configure a disk-backed storage layer (`Storage.layerDisk` or `Storage.layerTemp`).",
        });
      }
      const persistPath = path.join(storageDiskPath, "workflows");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              subtag: "Workflows",
              message: `Failed to create workflows persistence directory "${persistPath}": ${cause.message}`,
              hint: "Ensure the storage directory is writable.",
              detail: { persistPath },
              cause,
            }),
        ),
      );
      return {
        name: WORKFLOWS_STORAGE_SERVICE_NAME,
        disk: { path: persistPath, writable: true },
      } satisfies WorkerdConfig.Service;
    });

    return Workflows.of(
      Effect.gen(function* () {
        const ctx = yield* PluginContext;
        const proxy = yield* ctx.get(RegistryProxy);
        const owned = ctx.worker.workflows ?? [];
        const services: Array<WorkerdConfig.Service> = [];

        if (owned.length > 0) {
          services.push(yield* makeStorageService);
          const bindingModules = formatInternalWorkerModules(
            yield* Effect.promise(WorkflowsBindingWorker.worker),
          );
          for (const workflow of owned) {
            const serviceName = `workflows:${workflow.workflowName}`;
            services.push(
              makeEngineService({
                workflow,
                compatibilityFlags: ctx.worker.compatibilityFlags,
                modules: bindingModules,
              }),
            );
            yield* proxy.api.publish({
              kind: "workflow",
              workflowName: workflow.workflowName,
              service: serviceName,
            });
          }
        }

        return {
          defer: Effect.gen(function* () {
            // Always include the wrapped-binding extension (matches Miniflare):
            // consumer-only workers need it even when they own no engines.
            const extension: WorkerdConfig.Extension = {
              modules: [
                {
                  name: WORKFLOWS_WRAPPED_BINDING_MODULE,
                  internal: true,
                  esModule: yield* formatExtensionModule(
                    WorkflowsWrappedBindingWorker,
                  ),
                },
              ],
            };
            return {
              ...(services.length > 0 ? { services } : {}),
              extensions: [extension],
            };
          }),
        };
      }),
    );
  }),
);

const makeEngineService = ({
  workflow,
  compatibilityFlags,
  modules,
}: {
  workflow: Workflow;
  compatibilityFlags: ReadonlyArray<string> | undefined;
  modules: Array<WorkerdConfig.Worker_Module>;
}): WorkerdConfig.Service => ({
  name: `workflows:${workflow.workflowName}`,
  worker: {
    compatibilityDate: "2024-10-22",
    compatibilityFlags: ["experimental", ...(compatibilityFlags ?? [])],
    modules,
    durableObjectNamespaces: [
      {
        className: "Engine",
        enableSql: true,
        uniqueKey: encodeURIComponent(workflow.workflowName),
        preventEviction: true,
      },
    ],
    durableObjectStorage: {
      localDisk: WORKFLOWS_STORAGE_SERVICE_NAME,
    },
    bindings: [
      {
        name: "ENGINE",
        durableObjectNamespace: { className: "Engine" },
      },
      {
        name: "USER_WORKFLOW",
        service: {
          name: SERVICE_USER_WORKER,
          entrypoint: workflow.className,
        },
      },
      {
        name: "BINDING_NAME",
        // Engines are keyed by workflow name; binding names live on the
        // consumer side. Introspection uses this as a display label.
        json: JSON.stringify(workflow.workflowName),
      },
      {
        name: "WORKFLOW_NAME",
        json: JSON.stringify(workflow.workflowName),
      },
      ...(workflow.stepLimit !== undefined
        ? [
            {
              name: "STEP_LIMIT",
              json: JSON.stringify(workflow.stepLimit),
            },
          ]
        : []),
    ],
  },
});

export interface LocalWorkflowProps {
  /**
   * Name of the binding.
   */
  readonly binding: string;
  /**
   * Logical name of the workflow to bind to.
   */
  readonly workflowName: string;
  /**
   * Class name of the `WorkflowEntrypoint`. Must match the owned workflow
   * when binding to the current worker.
   */
  readonly className: string;
  /**
   * If set and the referenced worker isn't the current one, the binding is
   * routed through the dev-registry proxy. This enables service-binding
   * style cross-process Workflow access during local development.
   */
  readonly scriptName?: string;
}

/**
 * Bind a workflow.
 *
 * - Without `scriptName`: bind a workflow defined on the current worker.
 * - With `scriptName === <current worker name>`: same as above.
 * - With `scriptName !== <current worker name>`: route through the dev
 *   registry proxy so the engine can live in a different `cloudflare-runtime`
 *   or `wrangler dev` process.
 */
export const local = ({
  binding,
  workflowName,
  className,
  scriptName,
}: LocalWorkflowProps): BindingHook<RegistryProxy> =>
  PluginContext.use((context) => {
    if (scriptName === undefined || scriptName === context.worker.name) {
      const workflow = context.worker.workflows?.find(
        (entry) => entry.workflowName === workflowName,
      );
      if (!workflow) {
        return Effect.fail(
          new ConfigError({
            subtag: "WorkflowNotFound",
            message: `Workflow ${workflowName} not found`,
            hint: `Make sure the workflow ${workflowName} is defined in the worker config`,
            detail: {
              workflowName,
              registeredWorkflows: context.worker.workflows?.map(
                (entry) => entry.workflowName,
              ),
            },
          }),
        );
      }
      if (workflow.className !== className) {
        return Effect.fail(
          new ConfigError({
            subtag: "WorkflowClassNameMismatch",
            message: `Workflow ${workflowName} has class name "${workflow.className}" but "${className}" was provided`,
          }),
        );
      }
      return Effect.succeed<WorkerdConfig.Worker_Binding>({
        name: binding,
        wrapped: {
          moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
          innerBindings: [
            {
              name: "binding",
              service: {
                name: `workflows:${workflowName}`,
                entrypoint: "WorkflowBinding",
              },
            },
          ],
        },
      });
    }
    return context.get(RegistryProxy).pipe(
      Effect.flatMap((proxy) =>
        proxy.api.subscribe({
          kind: "workflow",
          scriptName,
          workflowName,
        }),
      ),
      Effect.map((service): WorkerdConfig.Worker_Binding => ({
        name: binding,
        wrapped: {
          moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
          innerBindings: [{ name: "binding", service }],
        },
      })),
    );
  });

export interface RemoteWorkflowProps {
  readonly binding: string;
  readonly workflowName: string;
  readonly className: string;
  readonly scriptName?: string;
}

export const remote = (props: RemoteWorkflowProps) =>
  makeRemoteBinding(
    {
      name: props.binding,
      type: "workflow",
      workflowName: props.workflowName,
      className: props.className,
      scriptName: props.scriptName,
    },
    (service) => ({
      name: props.binding,
      service,
    }),
  );
