import {
  type DesktopGatewayHeadersEntry,
  type DesktopGatewayHeadersInput,
  DesktopGatewayHeaderSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const GatewayHeadersEntries = Schema.Array(
  Schema.Struct({
    origin: Schema.String,
    headers: Schema.Array(DesktopGatewayHeaderSchema),
  }),
);
type GatewayHeadersEntries = typeof GatewayHeadersEntries.Type;
const GatewayHeadersEntriesJson = Schema.fromJsonString(GatewayHeadersEntries);
const decodeEntriesJson = Schema.decodeEffect(GatewayHeadersEntriesJson);
const encodeEntriesJson = Schema.encodeEffect(GatewayHeadersEntriesJson);

const GatewayHeadersDocumentJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), encryptedEntries: Schema.String }),
);
const decodeDocumentJson = Schema.decodeEffect(GatewayHeadersDocumentJson);
const encodeDocumentJson = Schema.encodeEffect(GatewayHeadersDocumentJson);

export class DesktopGatewayHeadersError extends Schema.TaggedError<DesktopGatewayHeadersError>()(
  "DesktopGatewayHeadersError",
  {
    reason: Schema.Literals([
      "invalid-origin",
      "encryption-unavailable",
      "persist-failed",
      "apply-failed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-origin":
        return "Gateway headers need an http or https environment address.";
      case "encryption-unavailable":
        return "Gateway headers need the system keychain, which is unavailable.";
      case "persist-failed":
        return "Could not save the gateway headers.";
      case "apply-failed":
        return "Could not apply the gateway headers.";
    }
  }
}

/** The http(s) origin a request belongs to; WebSocket upgrades share their page origin's headers. */
function gatewayOrigin(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

export function gatewayUrlPatterns(origins: ReadonlyArray<string>): ReadonlyArray<string> {
  return origins.flatMap((origin) => {
    const url = new URL(origin);
    const socketScheme = url.protocol === "https:" ? "wss:" : "ws:";
    return [`${url.protocol}//${url.host}/*`, `${socketScheme}//${url.host}/*`];
  });
}

export function withGatewayHeaders(
  entries: GatewayHeadersEntries,
  url: string,
  requestHeaders: Record<string, string>,
): Record<string, string> {
  const origin = gatewayOrigin(url);
  const entry = origin === null ? undefined : entries.find((item) => item.origin === origin);
  if (entry === undefined) return requestHeaders;
  const next = { ...requestHeaders };
  for (const header of entry.headers) next[header.name] = header.value;
  return next;
}

const toEntryViews = (entries: GatewayHeadersEntries): ReadonlyArray<DesktopGatewayHeadersEntry> =>
  entries.map((entry) => ({
    origin: entry.origin,
    headerNames: entry.headers.map((header) => header.name),
  }));

/** Installs or, with `null`, removes the one request-header listener for the window's session. */
export type GatewayRequestHook = (
  urls: ReadonlyArray<string> | null,
  rewrite: (url: string, requestHeaders: Record<string, string>) => Record<string, string>,
) => void;

const electronRequestHook: GatewayRequestHook = (urls, rewrite) => {
  const { webRequest } = Electron.session.defaultSession;
  if (urls === null) {
    webRequest.onBeforeSendHeaders(null);
    return;
  }
  webRequest.onBeforeSendHeaders({ urls: [...urls] }, (details, callback) => {
    callback({ requestHeaders: rewrite(details.url, details.requestHeaders) });
  });
};

export class DesktopGatewayHeaders extends Context.Service<
  DesktopGatewayHeaders,
  {
    /** Loads saved headers and starts adding them. Runs once Electron is ready. */
    readonly install: Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<DesktopGatewayHeadersEntry>>;
    readonly set: (
      input: DesktopGatewayHeadersInput,
    ) => Effect.Effect<ReadonlyArray<DesktopGatewayHeadersEntry>, DesktopGatewayHeadersError>;
    readonly remove: (
      origin: string,
    ) => Effect.Effect<ReadonlyArray<DesktopGatewayHeadersEntry>, DesktopGatewayHeadersError>;
  }
>()("@t3tools/desktop/app/DesktopGatewayHeaders") {}

export const make = Effect.fn("DesktopGatewayHeaders.make")(function* (hook: GatewayRequestHook) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const filePath = path.join(environment.stateDir, "gateway-headers.json");
  const entriesRef = yield* Ref.make<GatewayHeadersEntries>([]);
  const mutex = yield* Semaphore.make(1);

  const apply = (entries: GatewayHeadersEntries) =>
    Effect.try({
      try: () =>
        hook(
          entries.length === 0 ? null : gatewayUrlPatterns(entries.map((entry) => entry.origin)),
          (url, requestHeaders) => withGatewayHeaders(entries, url, requestHeaders),
        ),
      catch: (cause) => new DesktopGatewayHeadersError({ reason: "apply-failed", cause }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not apply desktop gateway headers.", { cause }),
      ),
    );

  const load = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) return [];
    const document = yield* decodeDocumentJson(yield* fileSystem.readFileString(filePath));
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedEntries));
    return yield* decodeEntriesJson(yield* safeStorage.decryptString(encrypted));
  });

  const persist = Effect.fn("DesktopGatewayHeaders.persist")(function* (
    entries: GatewayHeadersEntries,
  ) {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!available) {
      return yield* new DesktopGatewayHeadersError({ reason: "encryption-unavailable" });
    }
    yield* Effect.gen(function* () {
      const encrypted = yield* safeStorage.encryptString(yield* encodeEntriesJson(entries));
      const document = yield* encodeDocumentJson({
        version: 1,
        encryptedEntries: Base64.encode(encrypted),
      });
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      const tempPath = `${filePath}.${process.pid}.tmp`;
      yield* fileSystem.writeFileString(tempPath, `${document}\n`);
      yield* fileSystem.rename(tempPath, filePath);
    }).pipe(
      Effect.mapError(
        (cause) => new DesktopGatewayHeadersError({ reason: "persist-failed", cause }),
      ),
    );
    yield* Ref.set(entriesRef, entries);
    yield* apply(entries);
    return toEntryViews(entries);
  });

  const requireOrigin = (raw: string) => {
    const origin = gatewayOrigin(raw);
    return origin === null
      ? Effect.fail(new DesktopGatewayHeadersError({ reason: "invalid-origin" }))
      : Effect.succeed(origin);
  };

  const update = (change: (entries: GatewayHeadersEntries) => GatewayHeadersEntries) =>
    mutex.withPermits(1)(
      Ref.get(entriesRef).pipe(Effect.flatMap((entries) => persist(change(entries)))),
    );

  return DesktopGatewayHeaders.of({
    install: Effect.gen(function* () {
      const entries = yield* load.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read saved desktop gateway headers.", { cause }).pipe(
            Effect.as<GatewayHeadersEntries>([]),
          ),
        ),
      );
      yield* Ref.set(entriesRef, entries);
      yield* apply(entries);
    }).pipe(Effect.withSpan("DesktopGatewayHeaders.install")),
    list: Ref.get(entriesRef).pipe(Effect.map(toEntryViews)),
    set: Effect.fn("DesktopGatewayHeaders.set")(function* (input) {
      const origin = yield* requireOrigin(input.origin);
      return yield* update((entries) => [
        ...entries.filter((entry) => entry.origin !== origin),
        { origin, headers: input.headers },
      ]);
    }),
    remove: Effect.fn("DesktopGatewayHeaders.remove")(function* (rawOrigin) {
      const origin = yield* requireOrigin(rawOrigin);
      return yield* update((entries) => entries.filter((entry) => entry.origin !== origin));
    }),
  });
});

export const layer = Layer.effect(DesktopGatewayHeaders, make(electronRequestHook));
