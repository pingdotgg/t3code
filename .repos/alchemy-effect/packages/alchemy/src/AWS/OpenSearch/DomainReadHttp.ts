import * as Layer from "effect/Layer";
import {
  makeOpenSearchDataPlaneBinding,
  makeReadDomainClient,
} from "./DataPlaneHttp.ts";
import { DomainRead } from "./DomainRead.ts";

export const DomainReadHttp = Layer.effect(
  DomainRead,
  makeOpenSearchDataPlaneBinding({
    name: "DomainRead",
    iamActions: ["es:ESHttpGet", "es:ESHttpHead"],
    makeClient: makeReadDomainClient,
  }),
);
