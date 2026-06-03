import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import { BackendApi } from "./Spec.ts";

export const BackendClient = (baseUrl: string) =>
  HttpApiClient.make(BackendApi, { baseUrl });
