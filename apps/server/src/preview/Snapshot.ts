import {
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationError,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

export class PreviewTextCaptureError extends Schema.TaggedError<PreviewTextCaptureError>()(
  "PreviewTextCaptureError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the loaded page text. Take another snapshot with captureText=true if the page changed or the capture expired.";
  }
}

const isPreviewAutomationError = Schema.is(PreviewAutomationError);
const isPreviewTextCaptureError = Schema.is(PreviewTextCaptureError);
const textCaptureError = (cause: unknown) =>
  isPreviewAutomationError(cause) || isPreviewTextCaptureError(cause)
    ? cause
    : new PreviewTextCaptureError({ cause });

const Capture = Schema.Struct({
  totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
});
const TextChunk = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(4096)),
  nextOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  done: Schema.Boolean,
  released: Schema.Boolean,
});
const encodePageString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeCapture = Schema.decodeUnknownEffect(Capture);
const decodeTextChunk = Schema.decodeUnknownEffect(TextChunk);
const decodeStatus = Schema.decodeUnknownEffect(PreviewAutomationStatus);
const decodeSnapshot = Schema.decodeUnknownEffect(PreviewAutomationSnapshot);
const decodeCaptureMatch = Schema.decodeUnknownEffect(Schema.Literal(true));

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

interface SnapshotInput {
  readonly scope: PreviewAutomationBroker.PreviewAutomationInvokeInput["scope"];
  readonly tabId?: PreviewTabId | undefined;
  readonly captureText?: boolean | undefined;
  readonly save?: boolean | undefined;
}

interface SnapshotCapture {
  readonly snapshot: PreviewAutomationSnapshot;
  readonly png: Uint8Array;
  readonly textCapture?: {
    readonly captureId: string;
    readonly totalChars: number;
    readonly url: string;
    readonly tabId: PreviewTabId;
  };
  readonly screenshotPath?: string;
}

export class PreviewSnapshot extends Context.Service<
  PreviewSnapshot,
  {
    readonly readText: (input: {
      readonly scope: SnapshotInput["scope"];
      readonly tabId: PreviewTabId;
      readonly captureId: string;
      readonly offset?: number | undefined;
      readonly release?: boolean | undefined;
    }) => Effect.Effect<typeof TextChunk.Type, PreviewAutomationError | PreviewTextCaptureError>;
    readonly withSnapshot: <A, E, R>(
      input: SnapshotInput,
      use: (capture: SnapshotCapture) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      | E
      | PreviewAutomationError
      | PreviewTextCaptureError
      | PreviewScreenshotSaveError
      | Schema.SchemaError,
      R
    >;
  }
>()("t3/preview/Snapshot/PreviewSnapshot") {}

const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const captureKey = (scope: SnapshotInput["scope"]) =>
    `__t3_text_capture_${NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          scope.environmentId,
          scope.thread.threadId,
          scope.thread.providerSessionId,
          scope.thread.providerInstanceId,
        ]),
      )
      .digest("hex")}`;
  const evaluate = (scope: SnapshotInput["scope"], tabId: PreviewTabId, expression: string) =>
    broker.invoke({
      scope,
      operation: "evaluate",
      tabId,
      input: { expression, returnByValue: true },
      updateCurrentTab: false,
    });

  const readText = Effect.fn("PreviewSnapshot.readText")(function* (input: {
    readonly scope: SnapshotInput["scope"];
    readonly tabId: PreviewTabId;
    readonly captureId: string;
    readonly offset?: number | undefined;
    readonly release?: boolean | undefined;
  }) {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || input.captureId.length > 128) {
      return yield* new PreviewTextCaptureError({ cause: "Invalid capture or offset." });
    }
    const key = yield* encodePageString(captureKey(input.scope)).pipe(Effect.orDie);
    const id = yield* encodePageString(input.captureId).pipe(Effect.orDie);
    const chunk = yield* evaluate(
      input.scope,
      input.tabId,
      `(() => {
      const capture = globalThis[${key}];
      if (!capture || capture.captureId !== ${id}) return null;
      if (capture.document !== document || capture.url !== location.href) {
        capture.dispose();
        return null;
      }
      const totalChars = capture.text.length;
      if (${input.release === true}) {
        capture.dispose();
        return { text: "", nextOffset: 0, totalChars, done: true, released: true };
      }
      const offset = ${offset};
      if (offset > totalChars) return null;
      const first = capture.text.charCodeAt(offset);
      const previous = capture.text.charCodeAt(offset - 1);
      if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return null;
      let end = Math.min(offset + 4096, totalChars);
      if (new TextEncoder().encode(JSON.stringify({ text: capture.text.slice(offset, end) })).byteLength > 16000) {
        end = offset + Math.floor((end - offset) / 2);
      }
      if (end < totalChars) {
        const last = capture.text.charCodeAt(end - 1);
        const next = capture.text.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      }
      capture.refresh();
      return { text: capture.text.slice(offset, end), nextOffset: end, totalChars, done: end === totalChars, released: false };
    })()`,
    ).pipe(Effect.flatMap(decodeTextChunk), Effect.mapError(textCaptureError));
    if (
      !chunk.released &&
      (chunk.nextOffset !== offset + chunk.text.length ||
        chunk.nextOffset > chunk.totalChars ||
        (offset < chunk.totalChars && chunk.nextOffset <= offset) ||
        chunk.done !== (chunk.nextOffset === chunk.totalChars))
    ) {
      return yield* new PreviewTextCaptureError({ cause: "Invalid text capture chunk." });
    }
    return chunk;
  });

  const saveScreenshot = Effect.fn("PreviewSnapshot.saveScreenshot")(function* (
    pageUrl: string,
    data: Uint8Array,
  ) {
    const millis = yield* Clock.currentTimeMillis;
    const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
    const screenshotPath = path.join(config.browserArtifactsDir, fileName);
    yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
      Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
    );
    return screenshotPath;
  });

  const withSnapshot = Effect.fn("PreviewSnapshot.withSnapshot")(function* <A, E, R>(
    input: SnapshotInput,
    use: (capture: SnapshotCapture) => Effect.Effect<A, E, R>,
  ) {
    const captureId = NodeCrypto.randomUUID();
    const key = yield* encodePageString(captureKey(input.scope)).pipe(Effect.orDie);
    const id = yield* encodePageString(captureId).pipe(Effect.orDie);
    let captureTabId: PreviewTabId | undefined;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let textCapture: SnapshotCapture["textCapture"];
        if (input.captureText === true) {
          let tabId = input.tabId;
          if (tabId === undefined) {
            const status = yield* restore(
              broker
                .invoke({ scope: input.scope, operation: "status", input: {} })
                .pipe(Effect.flatMap(decodeStatus), Effect.mapError(textCaptureError)),
            );
            if (!status.available || status.tabId === null) {
              return yield* new PreviewTextCaptureError({ cause: "No available preview tab." });
            }
            tabId = status.tabId;
          }
          captureTabId = tabId;
          const capture = yield* restore(
            evaluate(
              input.scope,
              tabId,
              `(() => {
            globalThis[${key}]?.dispose();
            const text = document.body?.innerText ?? "";
            let timer;
            const dispose = () => {
              clearTimeout(timer);
              removeEventListener("pagehide", dispose);
              if (globalThis[${key}] === capture) delete globalThis[${key}];
            };
            const refresh = () => {
              clearTimeout(timer);
              timer = setTimeout(dispose, 300000);
            };
            const capture = Object.freeze({ captureId: ${id}, text, url: location.href, document, dispose, refresh });
            Object.defineProperty(globalThis, ${key}, { value: capture, configurable: true });
            addEventListener("pagehide", dispose, { once: true });
            refresh();
            return { totalChars: text.length, url: capture.url.slice(0, 2048) };
          })()`,
            ).pipe(Effect.flatMap(decodeCapture), Effect.mapError(textCaptureError)),
          );
          textCapture = { captureId, ...capture, tabId };
        }
        return yield* restore(
          Effect.gen(function* () {
            const tabId = textCapture?.tabId ?? input.tabId;
            const snapshot = yield* broker
              .invoke({
                scope: input.scope,
                operation: "snapshot",
                input: {},
                ...(tabId === undefined ? {} : { tabId }),
              })
              .pipe(Effect.flatMap(decodeSnapshot));
            if (textCapture !== undefined) {
              for (let offset = 0; offset < Math.max(snapshot.url.length, 1); offset += 4096) {
                const urlChunk = yield* encodePageString(
                  snapshot.url.slice(offset, offset + 4096),
                ).pipe(Effect.orDie);
                yield* evaluate(
                  input.scope,
                  textCapture.tabId,
                  `(() => {
                const capture = globalThis[${key}];
                if (!capture || capture.captureId !== ${id} || capture.document !== document || capture.url !== location.href) return false;
                capture.refresh();
                return capture.url.length === ${snapshot.url.length} && capture.url.slice(${offset}, ${offset + 4096}) === ${urlChunk};
              })()`,
                ).pipe(Effect.flatMap(decodeCaptureMatch), Effect.mapError(textCaptureError));
              }
            }
            const png = new Uint8Array(Buffer.from(snapshot.screenshot.data, "base64"));
            const screenshotPath =
              input.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
            return yield* use({
              snapshot,
              png,
              ...(textCapture === undefined ? {} : { textCapture }),
              ...(screenshotPath === undefined ? {} : { screenshotPath }),
            });
          }),
        );
      }),
    ).pipe(
      Effect.onExit((exit) =>
        captureTabId !== undefined && exit._tag === "Failure"
          ? evaluate(
              input.scope,
              captureTabId,
              `(() => {
            const capture = globalThis[${key}];
            if (capture?.captureId === ${id}) capture.dispose();
            return true;
          })()`,
            ).pipe(Effect.interruptible, Effect.timeoutOption(5000), Effect.ignore)
          : Effect.void,
      ),
    );
  });

  return PreviewSnapshot.of({ withSnapshot, readText });
});

export const layer = Layer.effect(PreviewSnapshot, make);
