import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT } from "./shared.ts";

export const ChecksSite = Fly.App("ChecksSite");

export default class ChecksApi extends Fly.Service<ChecksApi>()(
  "ChecksApi",
  {
    app: ChecksSite,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    services: [
      {
        protocol: "tcp",
        internalPort: API_PORT,
        autostart: true,
        autostop: "off",
        minMachinesRunning: 1,
        ports: [
          { port: 80, handlers: ["http"], forceHttps: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
        checks: [
          {
            type: "http",
            port: API_PORT,
            method: "GET",
            path: "/health",
            protocol: "http",
            interval: "15s",
            timeout: "3s",
            gracePeriod: "20s",
          },
        ],
      },
    ],
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        return path === "/health"
          ? yield* HttpServerResponse.json({ ok: true })
          : HttpServerResponse.empty({ status: 404 });
      }),
    };
  }),
) {}
