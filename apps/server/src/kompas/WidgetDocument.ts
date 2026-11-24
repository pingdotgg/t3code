import type { KompasError, ThreadId } from "@t3tools/contracts";
import {
  mcpAppContentSecurityPolicy,
  type McpAppCsp,
  type McpAppReference,
} from "@t3tools/shared/mcpApp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { kompasError, storageError } from "./KompasDatabase.ts";

export type WidgetName =
  | "flashcards"
  | "quiz"
  | "chart"
  | "diagram"
  | "map"
  | "math"
  | "timeline"
  | "table"
  | "choices"
  | "memory"
  | "decision"
  | "suggestions";

/** Keyless tiles that allow apps, unlike tile.openstreetmap.org. MapLibre's worker is a blob. */
const MAP_CSP: McpAppCsp = {
  connectDomains: ["https://tiles.openfreemap.org"],
  resourceDomains: ["https://tiles.openfreemap.org", "blob:"],
};
const cspOf = (widget: string) => (widget === "map" ? MAP_CSP : undefined);

const widgetUri = (widget: string) => `ui://widgets/${widget}`;

const MARKER = /^<!doctype html><!--kompas-widget:([a-z]+)-->/;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const DATA_SLOT = "<!--widget-data-->";

const escapeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Where the built widget pages are: beside the web client when bundled, else the package. */
const resolveWidgetFile = Effect.fn("WidgetDocument.resolveWidgetFile")(function* (widget: string) {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const candidates = [
    path.resolve(import.meta.dirname, "client/kompas-widgets", `${widget}.html`),
    path.resolve(import.meta.dirname, "../../../../packages/widgets/dist", `${widget}.html`),
  ];
  for (const candidate of candidates) {
    const present = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (present) return candidate;
  }
  return undefined;
});

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:12px">This widget is not built. Run <code>vp run --filter @t3tools/widgets build</code>.</body>`;

/**
 * Turns a stored widget (its name and data) into its page. A stored copy of the page would cost
 * megabytes per call and keep old widgets from ever being fixed.
 */
export const composeWidgetDocument = Effect.fn("WidgetDocument.compose")(function* (
  stored: string,
) {
  const widget = MARKER.exec(stored)?.[1];
  if (widget === undefined) return stored;
  const fileSystem = yield* FileSystem.FileSystem;
  const file = yield* resolveWidgetFile(widget);
  if (file === undefined) return NOT_BUILT;
  const page = yield* fileSystem.readFileString(file);
  const csp = mcpAppContentSecurityPolicy(cspOf(widget));
  return page
    .replace(
      /^<!doctype html>/i,
      () =>
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    )
    .replace(DATA_SLOT, () => stored.replace(MARKER, ""));
});

/** A widget as it was published: what it draws, and the data it was given. */
export interface StoredWidget {
  readonly name: string;
  readonly data: unknown;
}

const DATA = /<script type="application\/json" id="widget-data">(.*)<\/script>$/s;
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const readStoredWidget = (stored: string): StoredWidget | undefined => {
  const name = MARKER.exec(stored)?.[1];
  const json = DATA.exec(stored)?.[1];
  if (name === undefined || json === undefined) return undefined;
  return Option.getOrUndefined(Option.map(decodeJson(json), (data) => ({ name, data })));
};

export class WidgetPublisher extends Context.Service<
  WidgetPublisher,
  {
    /** Stores a widget in its thread and returns the reference clients render. */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly tool: string;
      readonly widget: WidgetName;
      readonly data: unknown;
    }) => Effect.Effect<Omit<McpAppReference, "server">, KompasError>;
    /** Undefined when the reference names no widget, or not the one it was published as. */
    readonly read: (
      reference: Pick<McpAppReference, "attachmentId" | "resourceUri">,
    ) => Effect.Effect<StoredWidget | undefined>;
  }
>()("t3/kompas/WidgetDocument/WidgetPublisher") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  const publish: WidgetPublisher["Service"]["publish"] = Effect.fn("WidgetPublisher.publish")(
    function* (input) {
      // The `-html` suffix makes the asset route serve it as a sandboxed document.
      const attachmentId = createAttachmentId(input.threadId, "html");
      const filePath =
        attachmentId === null
          ? null
          : resolveAttachmentRelativePath({
              attachmentsDir: config.attachmentsDir,
              relativePath: `${attachmentId}.html`,
            });
      if (attachmentId === null || filePath === null) {
        return yield* kompasError("invalid", "This thread cannot hold widgets.");
      }
      // `<` would let data close the script element that carries it.
      const json = encodeJson(input.data).replaceAll("<", "\\u003c");
      yield* fileSystem
        .writeFileString(
          filePath,
          `<!doctype html><!--kompas-widget:${input.widget}--><script type="application/json" id="widget-data">${json}</script>`,
        )
        .pipe(
          Effect.onError(() => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)),
          Effect.mapError(storageError),
        );
      return {
        attachmentId,
        tool: input.tool,
        resourceUri: widgetUri(input.widget),
        prefersBorder: false,
      };
    },
  );

  const read: WidgetPublisher["Service"]["read"] = Effect.fn("WidgetPublisher.read")(
    function* (reference) {
      const filePath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${reference.attachmentId}.html`,
      });
      if (filePath === null) return undefined;
      const stored = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.orElseSucceed(() => ""));
      const widget = readStoredWidget(stored);
      return widget !== undefined && widgetUri(widget.name) === reference.resourceUri
        ? widget
        : undefined;
    },
  );

  return WidgetPublisher.of({ publish, read });
});

export const layer = Layer.effect(WidgetPublisher, make);
