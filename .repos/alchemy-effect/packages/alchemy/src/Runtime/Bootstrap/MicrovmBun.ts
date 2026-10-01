/** `AWS.Lambda.MicrovmImage` bootstrap on the bun runtime. */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "../../Http.ts";
import { bootstrapMicrovm, type MicrovmBootstrapOptions } from "./Microvm.ts";

export const bootstrap = (
  entrypoint: unknown,
  options: MicrovmBootstrapOptions,
): Promise<void> =>
  bootstrapMicrovm(
    { services: BunServices.layer, httpServer: BunHttpServer() },
    entrypoint,
    options,
  );
