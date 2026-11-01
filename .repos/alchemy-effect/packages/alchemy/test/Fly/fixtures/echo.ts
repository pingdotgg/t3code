import * as Fly from "@/Fly";
import type { ServiceProps } from "@/Fly/Service";
import * as pathe from "pathe";

/** Body served by `echo-server.ts`. */
export const ECHO_BODY = "fly-echo";

/**
 * An external Service running `echo-server.ts` on port 3000. Set
 * `env.ECHO_BODY` to change the response body.
 */
export const Echo = (
  options: Partial<Omit<ServiceProps, "main">> = {},
  id = "Echo",
) =>
  Fly.Service(id, {
    main: pathe.resolve(import.meta.dirname, "echo-server.ts"),
    port: 3000,
    region: "iad",
    ...options,
  });
