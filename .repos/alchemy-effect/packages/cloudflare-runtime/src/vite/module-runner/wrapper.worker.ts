import {
  DurableObject,
  WorkerEntrypoint,
  WorkflowEntrypoint,
} from "cloudflare:workers";

import { INIT_PATH } from "./constants.shared.ts";
import type { Env as WrapperEnv } from "./env.worker.ts";
import { stripInternalEnv } from "./env.worker.ts";
import { getWorkerEntryExport } from "./module-runner.worker.ts";

/**
 * Constructor interface for `WorkerEntrypoint` class.
 * @template T - The `env` type
 */
interface WorkerEntrypointConstructor<T = Cloudflare.Env> {
  new (
    ...args: ConstructorParameters<typeof WorkerEntrypoint<T>>
  ): WorkerEntrypoint<T>;
}

/**
 * Constructor interface for `DurableObject` class.
 * @template T - The `env` type
 */
interface DurableObjectConstructor<T = Cloudflare.Env> {
  new (
    ...args: ConstructorParameters<typeof DurableObject<T>>
  ): DurableObject<T>;
}

/**
 * Constructor interface for `WorkflowEntrypoint` class.
 * @template T - The `env` type
 */
interface WorkflowEntrypointConstructor<T = Cloudflare.Env> {
  new (
    ...args: ConstructorParameters<typeof WorkflowEntrypoint<T>>
  ): WorkflowEntrypoint<T>;
}

/** Keys that should be ignored during RPC property access */
export const IGNORED_KEYS = ["self"] as const;

/** Available methods for `WorkerEntrypoint` class */
export const WORKER_ENTRYPOINT_KEYS = [
  "connect",
  "email",
  "fetch",
  "queue",
  "tail",
  "tailStream",
  "test",
  "trace",
  "scheduled",
] as const;

/** Available methods for `DurableObject` class */
export const DURABLE_OBJECT_KEYS = [
  "alarm",
  "connect",
  "fetch",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
] as const;

/** Available methods for `WorkflowEntrypoint` classes */
export const WORKFLOW_ENTRYPOINT_KEYS = ["run"] as const;

/**
 * Creates a proxy wrapper for `WorkerEntrypoint` classes that enables RPC functionality.
 * The wrapper intercepts property access and delegates to the user code, handling both direct method calls and RPC property access.
 * @param exportName - The name of the `WorkerEntrypoint` export to wrap
 * @returns A `WorkerEntrypoint` constructor that acts as a proxy to the user code
 */
export function createWorkerEntrypointWrapper(
  exportName: string,
): WorkerEntrypointConstructor<WrapperEnv> {
  class Wrapper extends WorkerEntrypoint<WrapperEnv> {
    constructor(ctx: ExecutionContext, env: WrapperEnv) {
      super(ctx, env);

      return new Proxy(this, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);

          if (value !== undefined) {
            return value;
          }

          if (
            typeof key === "symbol" ||
            (IGNORED_KEYS as ReadonlyArray<string>).includes(key) ||
            // The class methods are accessed to determine the type of the export.
            // We should therefore avoid proxying `DurableObject` methods on the `WorkerEntrypoint` class.
            (DURABLE_OBJECT_KEYS as ReadonlyArray<string>).includes(key)
          ) {
            return;
          }

          const property = getWorkerEntrypointRpcProperty.call(
            receiver,
            exportName,
            key,
          );

          return getRpcPropertyCallableThenable(key, property);
        },
      });
    }
  }

  for (const key of WORKER_ENTRYPOINT_KEYS) {
    Wrapper.prototype[key] = async function (arg) {
      const proxy = async () => {
        const exportValue = await getWorkerEntryExport(this.env, exportName);
        const userEnv = stripInternalEnv(this.env);

        if (typeof exportValue === "object" && exportValue !== null) {
          // The export is an `ExportedHandler`
          const maybeFn = (exportValue as Record<string, unknown>)[key];

          if (typeof maybeFn !== "function") {
            throw new TypeError(
              `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to define a \`${key}()\` function.`,
            );
          }

          return maybeFn.call(exportValue, arg, userEnv, this.ctx);
        } else if (typeof exportValue === "function") {
          // The export is a `WorkerEntrypoint`
          const ctor = exportValue as WorkerEntrypointConstructor;
          const instance = new ctor(this.ctx, userEnv);

          if (!(instance instanceof WorkerEntrypoint)) {
            throw new TypeError(
              `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be a subclass of \`WorkerEntrypoint\`.`,
            );
          }

          const maybeFn = instance[key];

          if (typeof maybeFn !== "function") {
            throw new TypeError(
              `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to define a \`${key}()\` method.`,
            );
          }

          return (maybeFn as (arg: unknown) => unknown).call(instance, arg);
        } else {
          throw new TypeError(
            `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be an object or a class.`,
          );
        }
      };

      if (key === "fetch") {
        const request = arg as Request;
        const url = new URL(request.url);
        // Initialize the module runner
        if (url.pathname === INIT_PATH) {
          const stub = this.env.__DISTILLED_MODULE_RUNNER__.get("singleton");
          return stub.fetch(request);
        }
        try {
          return await proxy();
        } catch (error) {
          // oxlint-disable no-console
          console.error("Error calling fetch", error);
          throw error;
        }
      }
      return await proxy();
    };
  }

  return Wrapper;
}

/**
 * Retrieves an RPC property from a `WorkerEntrypoint` export, creating an instance and returning the bound method or property value.
 * @param exportName - The name of the `WorkerEntrypoint` export
 * @param key - The property key to access on the `WorkerEntrypoint` instance
 * @returns The property value, with methods bound to the instance
 * @throws TypeError if the export is not a `WorkerEntrypoint` subclass
 */
async function getWorkerEntrypointRpcProperty(
  this: WorkerEntrypoint<WrapperEnv>,
  exportName: string,
  key: string,
): Promise<unknown> {
  const ctor = (await getWorkerEntryExport(
    this.env,
    exportName,
  )) as WorkerEntrypointConstructor;
  const userEnv = stripInternalEnv(this.env);
  const expectedWorkerEntrypointMessage = `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be a subclass of \`WorkerEntrypoint\` for RPC.`;

  if (typeof ctor !== "function") {
    throw new TypeError(expectedWorkerEntrypointMessage);
  }

  const instance = new ctor(this.ctx, userEnv);

  if (!(instance instanceof WorkerEntrypoint)) {
    throw new TypeError(expectedWorkerEntrypointMessage);
  }

  const value = getRpcProperty(ctor, instance, key);

  if (typeof value === "function") {
    return value.bind(instance);
  }

  return value;
}

/** Symbol key for storing the `DurableObject` instance */
const kInstance = Symbol("kInstance");
/** Symbol key for the instance initialization method */
const kEnsureInstance = Symbol("kEnsureInstance");

/**
 * Container for a `DurableObject` constructor and its instance.
 */
interface DurableObjectInstance {
  ctor: DurableObjectConstructor;
  instance: DurableObject;
}

/**
 * Extended `DurableObject` interface that includes instance management methods.
 */
interface DurableObjectWrapper extends DurableObject<WrapperEnv> {
  [kInstance]?: DurableObjectInstance;
  [kEnsureInstance](): Promise<DurableObjectInstance>;
}

/**
 * Retrieves an RPC property from a `DurableObject` export, ensuring an instance is properly initialized and returning the bound method or property value.
 * @param exportName - The name of the `DurableObject` export
 * @param key - The property key to access on the `DurableObject` instance
 * @returns The property value, with methods bound to the instance
 * @throws TypeError if the export is not a `DurableObject` subclass
 */
async function getDurableObjectRpcProperty(
  this: DurableObjectWrapper,
  exportName: string,
  key: string,
): Promise<unknown> {
  const { ctor, instance } = await this[kEnsureInstance]();

  if (!(instance instanceof DurableObject)) {
    throw new TypeError(
      `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be a subclass of \`DurableObject\` for RPC.`,
    );
  }

  const value = getRpcProperty(ctor, instance, key);

  if (typeof value === "function") {
    return value.bind(instance);
  }

  return value;
}

/**
 * Creates a proxy wrapper for `DurableObject` classes that enables RPC functionality.
 * The wrapper manages instance lifecycle and delegates method calls to the user code, handling both direct method calls and RPC property access.
 * @param exportName - The name of the `DurableObject` export to wrap
 * @returns A `DurableObject` constructor that acts as a proxy to the user code
 */
export function createDurableObjectWrapper(
  exportName: string,
): DurableObjectConstructor<WrapperEnv> {
  class Wrapper
    extends DurableObject<WrapperEnv>
    implements DurableObjectWrapper
  {
    [kInstance]?: DurableObjectInstance;

    constructor(ctx: DurableObjectState, env: WrapperEnv) {
      super(ctx, env);

      return new Proxy(this, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);

          if (value !== undefined) {
            return value;
          }

          if (
            typeof key === "symbol" ||
            (IGNORED_KEYS as ReadonlyArray<string>).includes(key) ||
            // The class methods are accessed to determine the type of the export.
            // We should therefore avoid proxying `WorkerEntrypoint` methods on the `DurableObject` class.
            (WORKER_ENTRYPOINT_KEYS as ReadonlyArray<string>).includes(key)
          ) {
            return;
          }

          const property = getDurableObjectRpcProperty.call(
            receiver,
            exportName,
            key,
          );

          return getRpcPropertyCallableThenable(key, property);
        },
      });
    }

    async [kEnsureInstance]() {
      const ctor = (await getWorkerEntryExport(
        this.env,
        exportName,
      )) as DurableObjectConstructor;

      if (typeof ctor !== "function") {
        throw new TypeError(
          `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be a subclass of \`DurableObject\`.`,
        );
      }

      // We reuse the same instance unless the constructor changes
      if (!this[kInstance] || this[kInstance].ctor !== ctor) {
        const userEnv = stripInternalEnv(this.env);
        const instance = new ctor(this.ctx, userEnv);

        this[kInstance] = { ctor, instance };

        // Wait for `blockConcurrencyWhile()`s in the constructor to complete
        await this.ctx.blockConcurrencyWhile(async () => {});
      }

      return this[kInstance];
    }
  }

  for (const key of DURABLE_OBJECT_KEYS) {
    Wrapper.prototype[key] = async function (...args: Array<unknown>) {
      const { instance } = await this[kEnsureInstance]();
      const maybeFn = instance[key];

      if (typeof maybeFn !== "function") {
        throw new TypeError(
          `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to define a \`${key}()\` function.`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (maybeFn as (...args: Array<unknown>) => any).apply(
        instance,
        args,
      );
    };
  }

  return Wrapper;
}

/**
 * Creates a proxy wrapper for `WorkflowEntrypoint` classes.
 * The wrapper delegates method calls to the user code.
 * @param exportName - The name of the `WorkflowEntrypoint` export to wrap
 * @returns A `WorkflowEntrypoint` constructor that acts as a proxy to the user code
 */
export function createWorkflowEntrypointWrapper(
  exportName: string,
): WorkflowEntrypointConstructor<WrapperEnv> {
  class Wrapper extends WorkflowEntrypoint<WrapperEnv> {}

  for (const key of WORKFLOW_ENTRYPOINT_KEYS) {
    Wrapper.prototype[key] = async function (...args: Array<unknown>) {
      const ctor = (await getWorkerEntryExport(
        this.env,
        exportName,
      )) as WorkflowEntrypointConstructor;
      const userEnv = stripInternalEnv(this.env);
      const instance = new ctor(this.ctx, userEnv);

      if (!(instance instanceof WorkflowEntrypoint)) {
        throw new TypeError(
          `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to be a subclass of \`WorkflowEntrypoint\`.`,
        );
      }

      const maybeFn = instance[key];

      if (typeof maybeFn !== "function") {
        throw new TypeError(
          `Expected "${exportName}" export of "${this.env.__DISTILLED_ENVIRONMENT__.entryName}" to define a \`${key}()\` function.`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (maybeFn as (...args: Array<unknown>) => any).apply(
        instance,
        args,
      );
    };
  }

  return Wrapper;
}

/**
 * Creates a callable thenable that is used to access the properties of an RPC target.
 * It can be both awaited and invoked as a function.
 * This enables RPC properties to be used both as promises and callable functions.
 * @param key - The property key name used for error messages
 * @param property - The promise that resolves to the property value
 * @returns A callable thenable that implements both Promise and function interfaces
 */
function getRpcPropertyCallableThenable(
  key: string,
  property: Promise<unknown>,
): Promise<unknown> & ((...args: Array<unknown>) => Promise<unknown>) {
  const fn = async function (...args: Array<unknown>) {
    const maybeFn = await property;

    if (typeof maybeFn !== "function") {
      throw new TypeError(`"${key}" is not a function.`);
    }

    return maybeFn(...args);
  } as Promise<unknown> & ((...args: Array<unknown>) => Promise<unknown>);

  fn.then = (onFulfilled, onRejected) => property.then(onFulfilled, onRejected);
  fn.catch = (onRejected) => property.catch(onRejected);
  fn.finally = (onFinally) => property.finally(onFinally);

  return fn;
}

/**
 * Retrieves an RPC property from a constructor prototype, ensuring it exists on the prototype rather than the instance to maintain RPC compatibility.
 * @param ctor - The constructor function (`WorkerEntrypoint` or `DurableObject`)
 * @param instance - The instance to bind methods to
 * @param key - The property key to retrieve
 * @returns The property value from the prototype
 * @throws TypeError if the property doesn't exist on the prototype
 */
function getRpcProperty(
  ctor: WorkerEntrypointConstructor | DurableObjectConstructor,
  instance: WorkerEntrypoint | DurableObject,
  key: string,
): unknown {
  const prototypeHasKey = Reflect.has(ctor.prototype, key);

  if (!prototypeHasKey) {
    const instanceHasKey = Reflect.has(instance, key);

    if (instanceHasKey) {
      throw new TypeError(
        [
          `The RPC receiver's prototype does not implement "${key}", but the receiver instance does.`,
          "Only properties and methods defined on the prototype can be accessed over RPC.",
          `Ensure properties are declared as \`get ${key}() { ... }\` instead of \`${key} = ...\`,`,
          `and methods are declared as \`${key}() { ... }\` instead of \`${key} = () => { ... }\`.`,
        ].join("\n"),
      );
    }

    throw new TypeError(`The RPC receiver does not implement "${key}".`);
  }

  return Reflect.get(ctor.prototype, key, instance);
}
