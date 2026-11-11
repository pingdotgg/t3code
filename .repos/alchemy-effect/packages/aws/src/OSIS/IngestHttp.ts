import * as Layer from "effect/Layer";
import { makeOsisIngestBinding } from "./BindingHttp.ts";
import { Ingest } from "./Ingest.ts";

export const IngestHttp = Layer.effect(Ingest, makeOsisIngestBinding);
