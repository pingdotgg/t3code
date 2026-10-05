import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as http from "node:http";
import * as https from "node:https";

export interface TransportEvent {
  sequence: number;
  stage:
    | "request"
    | "completed"
    | "forwarded"
    | "dropped"
    | "cut"
    | "held"
    | "upstream-error";
  method: string;
  path: string;
  machineId?: string;
  name?: string;
  phase?: string;
  status?: number;
  image?: string;
  digest?: string;
  instanceId?: string;
  state?: string;
  cordoned?: boolean;
  minSecretsVersion?: number;
  secretsVersion?: number;
  checks?: { name?: string; status?: string }[];
}

export interface FaultRule {
  match: (event: TransportEvent) => boolean;
  action: "drop-response" | "cut-request" | "hold-response";
  remaining: number;
}

/** No bodies, authorization headers, secret values, or lease nonces enter the journal. */
export const transportProxy = (upstream = "https://api.machines.dev") =>
  Effect.acquireRelease(
    Effect.callback<
      {
        url: string;
        events: TransportEvent[];
        arm: (rule: FaultRule) => void;
        clear: () => void;
        release: () => void;
        dropHeld: () => void;
        wait: (
          match: (event: TransportEvent) => boolean,
        ) => Effect.Effect<TransportEvent, Error>;
        close: () => void;
      },
      Error
    >((resume) => {
      const origin = new URL(upstream);
      if (origin.protocol !== "https:") {
        resume(
          Effect.fail(
            new Error("The fault proxy requires a real HTTPS upstream"),
          ),
        );
        return;
      }
      const events: TransportEvent[] = [];
      const listeners = new Set<(event: TransportEvent) => void>();
      const pending = new Set<http.ClientRequest>();
      const held = new Map<() => void, () => void>();
      const rules: FaultRule[] = [];
      let sequence = 0;
      const record = (event: TransportEvent) => {
        events.push(event);
        for (const listener of listeners) listener(event);
      };
      const server = http.createServer((incoming, outgoing) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("error", () => outgoing.destroy());
        incoming.on("end", () => {
          const body = Buffer.concat(chunks);
          const path = new URL(incoming.url!, origin).pathname;
          const event: TransportEvent = {
            sequence: ++sequence,
            stage: "request",
            method: incoming.method!,
            path,
            machineId: path.match(/\/machines\/([^/]+)/)?.[1],
          };
          // Only allowlisted identity/phase fields survive request inspection.
          if (
            body.length &&
            incoming.headers["content-type"]?.includes("json")
          ) {
            try {
              const value = JSON.parse(body.toString());
              if (typeof value.name === "string") event.name = value.name;
              if (typeof value.config?.image === "string")
                event.image = value.config.image;
              if (typeof value.min_secrets_version === "number")
                event.minSecretsVersion = value.min_secrets_version;
              const phase =
                value.metadata?.["alchemy.phase"] ??
                value.config?.metadata?.["alchemy.phase"];
              if (typeof phase === "string") event.phase = phase;
            } catch {
              // Forward malformed payloads unchanged; the real API decides their validity.
            }
          }
          record(event);
          const rule = rules.find(
            (rule) => rule.remaining > 0 && rule.match(event),
          );
          if (rule) rule.remaining--;
          if (rule?.action === "cut-request") {
            record({ ...event, stage: "cut" });
            incoming.socket.destroy();
            return;
          }
          const request = https.request(
            new URL(incoming.url!, origin),
            {
              method: incoming.method,
              headers: {
                ...incoming.headers,
                host: origin.host,
                connection: "close",
                "accept-encoding": "identity",
              },
            },
            (response) => {
              const parts: Buffer[] = [];
              response.on("data", (chunk: Buffer) => parts.push(chunk));
              response.on("error", () => outgoing.destroy());
              response.on("end", () => {
                pending.delete(request);
                const bytes = Buffer.concat(parts);
                const completed: TransportEvent = {
                  ...event,
                  status: response.statusCode,
                };
                if (response.statusCode! >= 200 && response.statusCode! < 300) {
                  try {
                    const value = JSON.parse(bytes.toString());
                    if (
                      /\/machines(?:\/[^/]+)?$/.test(path) &&
                      !Array.isArray(value)
                    ) {
                      if (typeof value.id === "string")
                        completed.machineId = value.id;
                      if (typeof value.instance_id === "string")
                        completed.instanceId = value.instance_id;
                      if (typeof value.image_ref?.digest === "string")
                        completed.digest = value.image_ref.digest;
                      if (typeof value.state === "string")
                        completed.state = value.state;
                      if (typeof value.cordoned === "boolean")
                        completed.cordoned = value.cordoned;
                      if (Array.isArray(value.checks)) {
                        completed.checks = value.checks.map(
                          (check: { name?: string; status?: string }) => ({
                            name:
                              typeof check.name === "string"
                                ? check.name
                                : undefined,
                            status:
                              typeof check.status === "string"
                                ? check.status
                                : undefined,
                          }),
                        );
                      }
                    }
                    if (/\/secrets(?:\/[^/]+)?$/.test(path)) {
                      const version = value.version ?? value.Version;
                      if (typeof version === "number")
                        completed.secretsVersion = version;
                    }
                  } catch {
                    // Response bytes are never altered to accommodate the observer.
                  }
                }
                record({ ...completed, stage: "completed" });
                const forward = () => {
                  const headers = { ...response.headers };
                  delete headers["transfer-encoding"];
                  delete headers.connection;
                  headers["content-length"] = String(bytes.length);
                  outgoing.writeHead(response.statusCode!, headers);
                  outgoing.end(bytes);
                  record({ ...completed, stage: "forwarded" });
                };
                if (rule?.action === "drop-response") {
                  record({ ...completed, stage: "dropped" });
                  incoming.socket.destroy();
                } else if (rule?.action === "hold-response") {
                  held.set(forward, () => {
                    record({ ...completed, stage: "dropped" });
                    incoming.socket.destroy();
                  });
                  record({ ...completed, stage: "held" });
                } else forward();
              });
            },
          );
          pending.add(request);
          request.setTimeout(90_000, () => request.destroy());
          request.on("error", () => {
            pending.delete(request);
            record({ ...event, stage: "upstream-error" });
            incoming.socket.destroy();
          });
          request.end(body);
        });
      });
      const close = () => {
        rules.length = 0;
        held.clear();
        for (const request of pending) request.destroy();
        server.closeAllConnections();
        server.close();
      };
      server.on("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          resume(Effect.fail(new Error("Missing proxy listen address")));
          return;
        }
        resume(
          Effect.succeed({
            url: `http://127.0.0.1:${address.port}`,
            events,
            arm: (rule) => rules.push({ ...rule }),
            clear: () => {
              rules.length = 0;
            },
            release: () => {
              for (const forward of held.keys()) forward();
              held.clear();
            },
            dropHeld: () => {
              for (const drop of held.values()) drop();
              held.clear();
            },
            wait: (match) =>
              Effect.callback<TransportEvent>((resume) => {
                const found = events.find(match);
                if (found) {
                  resume(Effect.succeed(found));
                  return;
                }
                const listener = (event: TransportEvent) => {
                  if (match(event)) {
                    listeners.delete(listener);
                    resume(Effect.succeed(event));
                  }
                };
                listeners.add(listener);
                return Effect.sync(() => listeners.delete(listener));
              }).pipe(
                Effect.timeout("120 seconds"),
                Effect.mapError(
                  () =>
                    new Error(
                      "Real API operation barrier was not reached within 120 seconds",
                    ),
                ),
              ),
            close,
          }),
        );
      });
      return Effect.sync(close);
    }),
    (proxy) =>
      Effect.forEach(
        Array.from(
          { length: Math.ceil(proxy.events.length / 50) },
          (_, index) => index,
        ),
        (index) =>
          Effect.logInfo("Fly transport journal", {
            endpoint: proxy.url,
            offset: index * 50,
            events: proxy.events.slice(index * 50, (index + 1) * 50),
          }),
        { discard: true },
      ).pipe(Effect.andThen(Effect.sync(proxy.close))),
  );

/** Adapt only transport routing; the original SDK, provider and real state remain intact. */
export const throughProxy = (endpoint: () => string | undefined) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      return HttpClient.mapRequest(client, (request) => {
        const url = endpoint();
        return url && request.url.startsWith("https://api.machines.dev/")
          ? HttpClientRequest.setUrl(
              request,
              request.url.replace("https://api.machines.dev", url),
            )
          : request;
      });
    }),
  ).pipe(Layer.provideMerge(Fly.providers()));
