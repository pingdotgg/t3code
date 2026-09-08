/** `AWS.Lambda.MicrovmImage` bootstrap on the node runtime. */
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "../../Http.ts";
import { bootstrapMicrovm, type MicrovmBootstrapOptions } from "./Microvm.ts";

export const bootstrap = (
  entrypoint: unknown,
  options: MicrovmBootstrapOptions,
): Promise<void> =>
  bootstrapMicrovm(
    { services: NodeServices.layer, httpServer: NodeHttpServer() },
    entrypoint,
    options,
  );
