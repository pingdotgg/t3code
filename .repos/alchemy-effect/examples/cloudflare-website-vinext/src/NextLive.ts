import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { BackendClient } from "./BackendClient";
import { FrontendApi } from "./NextApi";
import { FrontendHandlers } from "./NextHandlers";

const platformLayer = Layer.mergeAll(
  Etag.layer,
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
  FileSystem.layerNoop({}),
  Path.layer,
);

const FrontendLive = HttpApiBuilder.layer(FrontendApi).pipe(
  Layer.provide(FrontendHandlers.pipe(Layer.provide(BackendClient.Default))),
  Layer.provide(platformLayer),
);

const httpHandler = HttpRouter.toWebHandler(FrontendLive, {
  disableLogger: true,
});

export const handleApiRequest = (request: Request) => httpHandler.handler(request);
