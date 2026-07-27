import * as Layer from "effect/Layer";
import {
  makeOpenSearchDataPlaneBinding,
  makeWriteDomainClient,
} from "./DataPlaneHttp.ts";
import { DomainWrite } from "./DomainWrite.ts";

export const DomainWriteHttp = Layer.effect(
  DomainWrite,
  makeOpenSearchDataPlaneBinding({
    name: "DomainWrite",
    iamActions: [
      "es:ESHttpPut",
      "es:ESHttpPost",
      "es:ESHttpDelete",
      "es:ESHttpPatch",
    ],
    makeClient: makeWriteDomainClient,
  }),
);
