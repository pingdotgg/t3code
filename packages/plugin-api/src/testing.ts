import { ThreadId, type PluginId, type PluginUiPlacementId, type ProjectId } from "./schema.ts";
import { PluginRuntimeError, PluginStoreError, type PluginActivationContext } from "./server.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PluginActivationHarnessError extends Data.TaggedError("PluginActivationHarnessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StoredPluginTestCommand {
  readonly invoke: (input: unknown) => Effect.Effect<unknown, Error>;
  readonly decodeOutput: (output: unknown) => Effect.Effect<unknown, PluginActivationHarnessError>;
}

export interface PluginActivationHarnessDocuments {
  readonly list: <A>(collection: string) => Effect.Effect<ReadonlyArray<A>, PluginStoreError>;
  readonly get: <A>(
    collection: string,
    documentId: string,
  ) => Effect.Effect<A | null, PluginStoreError>;
  readonly upsert: <A>(
    collection: string,
    documentId: string,
    document: A,
  ) => Effect.Effect<void, PluginStoreError>;
  readonly delete: (
    collection: string,
    documentId: string,
  ) => Effect.Effect<void, PluginStoreError>;
}

export interface PluginActivationTestHarness {
  readonly ctx: PluginActivationContext;
  readonly documents: PluginActivationHarnessDocuments;
  readonly rawDocuments: Map<string, Map<string, unknown>>;
  readonly collections: Set<string>;
  readonly commands: Map<string, StoredPluginTestCommand>;
  readonly launchedThreads: Array<{
    readonly projectId: ProjectId;
    readonly title: string;
    readonly prompt: string;
  }>;
  readonly publishedEvents: Array<unknown>;
  readonly badgeProviders: Map<PluginUiPlacementId, () => Effect.Effect<number, Error>>;
}

interface MakePluginActivationTestHarnessOptions {
  readonly pluginId: PluginId;
  readonly paths?: PluginActivationContext["paths"] | undefined;
  readonly createAndSendThread?:
    | PluginActivationContext["runtime"]["createAndSendThread"]
    | undefined;
  readonly beforeDocumentUpsert?:
    | ((input: {
        readonly collection: string;
        readonly documentId: string;
        readonly document: unknown;
      }) => Effect.Effect<void, PluginStoreError>)
    | undefined;
}

const defaultPaths: PluginActivationContext["paths"] = {
  dataDir: "/tmp/t3-plugin-harness-test/data",
  cacheDir: "/tmp/t3-plugin-harness-test/cache",
  tempDir: "/tmp/t3-plugin-harness-test/tmp",
};

export function makePluginActivationTestHarness(
  options: MakePluginActivationTestHarnessOptions,
): PluginActivationTestHarness {
  const schemas = new Map<string, Schema.Codec<unknown, unknown>>();
  const documents = new Map<string, Map<string, unknown>>();
  const collections = new Set<string>();
  const commands = new Map<string, StoredPluginTestCommand>();
  const launchedThreads: PluginActivationTestHarness["launchedThreads"] = [];
  const publishedEvents: Array<unknown> = [];
  const badgeProviders = new Map<PluginUiPlacementId, () => Effect.Effect<number, Error>>();

  const requireSchema = (collection: string) =>
    Effect.sync(() => schemas.get(collection)).pipe(
      Effect.flatMap((schema) =>
        schema
          ? Effect.succeed(schema)
          : Effect.fail(new PluginStoreError(`Collection ${collection} is not registered.`)),
      ),
    );

  const decode = (collection: string, value: unknown) =>
    requireSchema(collection).pipe(
      Effect.flatMap((schema) => Schema.decodeUnknownEffect(schema)(value)),
      Effect.mapError((cause) => new PluginStoreError(`Invalid ${collection} document.`, cause)),
    );

  const collectionMap = (collection: string) => {
    let values = documents.get(collection);
    if (!values) {
      values = new Map<string, unknown>();
      documents.set(collection, values);
    }
    return values;
  };

  const documentStore: PluginActivationHarnessDocuments = {
    list: <A>(collection: string) =>
      Effect.gen(function* () {
        yield* requireSchema(collection);
        const values = Array.from(collectionMap(collection).values());
        return yield* Effect.forEach(values, (value) => decode(collection, value), {
          concurrency: 1,
        });
      }).pipe(Effect.map((values) => values as ReadonlyArray<A>)),
    get: <A>(collection: string, documentId: string) =>
      Effect.gen(function* () {
        yield* requireSchema(collection);
        const value = collectionMap(collection).get(documentId);
        if (value === undefined) {
          return null;
        }
        return (yield* decode(collection, value)) as A;
      }),
    upsert: (collection, documentId, document) =>
      Effect.gen(function* () {
        const decoded = yield* decode(collection, document);
        if (options.beforeDocumentUpsert) {
          yield* options.beforeDocumentUpsert({ collection, documentId, document: decoded });
        }
        collectionMap(collection).set(documentId, decoded);
      }),
    delete: (collection, documentId) =>
      Effect.sync(() => {
        collectionMap(collection).delete(documentId);
      }),
  };

  const defaultCreateAndSendThread: PluginActivationContext["runtime"]["createAndSendThread"] = (
    input,
  ) =>
    Effect.sync(() => {
      launchedThreads.push(input);
      return { threadId: ThreadId.make(`thread-${launchedThreads.length}`) };
    });

  const createAndSendThread =
    options.createAndSendThread ??
    ((input) =>
      defaultCreateAndSendThread(input).pipe(
        Effect.mapError((cause) => new PluginRuntimeError("Thread launch failed.", cause)),
      ));

  const ctx: PluginActivationContext = {
    pluginId: options.pluginId,
    paths: options.paths ?? defaultPaths,
    store: {
      registerCollection: <A, I>(collection: string, schema: Schema.Codec<A, I>) =>
        Effect.sync(() => {
          collections.add(collection);
          schemas.set(collection, schema as Schema.Codec<unknown, unknown>);
          return {
            list: () => documentStore.list<A>(collection),
            get: (documentId: string) => documentStore.get<A>(collection, documentId),
            upsert: (documentId: string, document: A) =>
              documentStore.upsert<A>(collection, documentId, document),
            delete: (documentId: string) => documentStore.delete(collection, documentId),
          };
        }),
    },
    commands: {
      register: (command, registration) =>
        Effect.sync(() => {
          const decodeInput = Schema.decodeUnknownEffect(registration.input);
          const decodeOutput = Schema.decodeUnknownEffect(registration.output);
          commands.set(command, {
            invoke: (value) =>
              decodeInput(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginActivationHarnessError({
                      message: "Invalid command input.",
                      cause,
                    }),
                ),
                Effect.flatMap(registration.handler),
              ),
            decodeOutput: (value) =>
              decodeOutput(value).pipe(
                Effect.mapError(
                  (cause) =>
                    new PluginActivationHarnessError({
                      message: "Invalid command output.",
                      cause,
                    }),
                ),
              ),
          });
        }),
    },
    ui: {
      setPlacementBadgeProvider: (placementId, provider) =>
        Effect.sync(() => {
          badgeProviders.set(placementId, provider);
        }),
    },
    runtime: {
      createAndSendThread,
    },
    events: {
      publish: (event) =>
        Effect.sync(() => {
          publishedEvents.push(event);
        }),
    },
  };

  return {
    ctx,
    documents: documentStore,
    rawDocuments: documents,
    collections,
    commands,
    launchedThreads,
    publishedEvents,
    badgeProviders,
  };
}
