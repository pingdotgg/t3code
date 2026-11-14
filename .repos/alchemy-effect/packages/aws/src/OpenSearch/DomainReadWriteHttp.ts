import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  makeOpenSearchDataPlaneBinding,
  makeReadDomainClient,
  makeWriteDomainClient,
} from "./DataPlaneHttp.ts";
import type { ReadWriteDomainClient } from "./DomainReadWrite.ts";
import { DomainReadWrite } from "./DomainReadWrite.ts";

export const DomainReadWriteHttp = Layer.effect(
  DomainReadWrite,
  makeOpenSearchDataPlaneBinding({
    name: "DomainReadWrite",
    iamActions: ["es:ESHttp*"],
    makeClient: (send): ReadWriteDomainClient => ({
      ...makeReadDomainClient(send),
      ...makeWriteDomainClient(send),
      request: (method, path, options) =>
        send({
          method,
          path,
          query: options?.query,
          json: options?.body,
        }).pipe(Effect.map(({ body }) => body)),
    }),
  }),
);
