import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http";

import { readSubmission } from "./http.ts";

it.effect("keeps a JSON file a guest attaches as a file, not a form field", () =>
  Effect.gen(function* () {
    const form = new FormData();
    form.append("shareId", "share-1");
    form.append("text", "");
    form.append("file", new File(['{"a":1}'], "data.json", { type: "application/json" }));
    const request = HttpServerRequest.fromWeb(
      new Request("http://localhost/api/guest/messages?share=share-1", {
        method: "POST",
        body: form,
      }),
    );
    const submission = yield* readSubmission.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    );
    assert.deepEqual(
      submission?.uploads.map((upload) => [upload.name, upload.contentType]),
      [["data.json", "application/json"]],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
