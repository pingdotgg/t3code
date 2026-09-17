import * as Fly from "@/Fly";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  API_PORT,
  BoxKey,
  Marker,
  SECRET_NAME,
  SignKey,
  Site,
} from "./bindings-shared.ts";

const bytesToB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const b64ToBytes = (value: string) =>
  Uint8Array.from(Buffer.from(value, "base64"));

/**
 * HTTP Service that exercises Secret and SecretKey bindings over
 * one route per behavior. Crypto runs on the Machine (PetSem), not
 * from a laptop Action.
 */
export default class BindingsApi extends Fly.Service<BindingsApi>()(
  "BindingsApi",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    yield* Marker;
    const get = yield* Fly.GetSecret(Marker);
    const list = yield* Fly.ListSecrets(Site);
    const write = yield* Fly.WriteSecret(Marker);
    const encrypt = yield* Fly.Encrypt(BoxKey);
    const decrypt = yield* Fly.Decrypt(BoxKey);
    const sign = yield* Fly.Sign(SignKey);
    const verify = yield* Fly.Verify(SignKey);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        const path = url.pathname;

        const fail = (error: unknown) => {
          const tagged =
            typeof error === "object" && error !== null && "_tag" in error
              ? (error as { _tag: string; message?: unknown })
              : undefined;
          const message =
            tagged !== undefined
              ? `${tagged._tag}${tagged.message === undefined ? "" : `: ${String(tagged.message)}`}`
              : error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
          return HttpServerResponse.json({ error: message }, { status: 500 });
        };

        if (path === "/health") {
          const token = process.env.FLY_API_TOKEN ?? "";
          return yield* HttpServerResponse.json({
            ok: true,
            hasToken: token.length > 0,
            hasAppName: typeof process.env.FLY_APP_NAME === "string",
            hasSecretName: typeof process.env.FLY_SECRET_Marker === "string",
            tokenKind: token.startsWith("{")
              ? "marker"
              : token.startsWith("FlyV1")
                ? "flyv1"
                : token.length > 0
                  ? "other"
                  : "missing",
          });
        }

        if (path === "/secret" && request.method === "GET") {
          const got = yield* get().pipe(
            Effect.catch((error) =>
              Effect.succeed({
                name: undefined as string | undefined,
                value: undefined as string | undefined,
                error:
                  error instanceof Error
                    ? `${error.name}: ${error.message}`
                    : String(error),
              }),
            ),
          );
          if ("error" in got) {
            return yield* HttpServerResponse.json(got, { status: 500 });
          }
          return yield* HttpServerResponse.json({
            ok: true,
            name: got.name,
            hasValue: typeof got.value === "string" && got.value.length > 0,
          });
        }

        if (path === "/secrets" && request.method === "GET") {
          return yield* list().pipe(
            Effect.flatMap((listed) =>
              HttpServerResponse.json({
                names: (listed.secrets ?? []).flatMap((row) =>
                  row.name === undefined ? [] : [row.name],
                ),
              }),
            ),
            Effect.catch((error) => fail(error)),
          );
        }

        if (path === "/secret" && request.method === "POST") {
          const body = (yield* request.json) as {
            name?: string;
            value?: string;
          };
          const name = body.name ?? "BINDING_CREATED";
          return yield* write
            .create(name, Redacted.make(body.value ?? "created"))
            .pipe(
              Effect.flatMap(() => HttpServerResponse.json({ ok: true, name })),
              Effect.catch((error) => fail(error)),
            );
        }

        if (path === "/encrypt" && request.method === "POST") {
          const body = (yield* request.json) as { text?: string };
          return yield* encrypt({
            plaintext: new TextEncoder().encode(body.text ?? ""),
          }).pipe(
            Effect.flatMap((enc) =>
              HttpServerResponse.json({
                ciphertext: bytesToB64(enc.ciphertext),
              }),
            ),
            Effect.catch((error) => fail(error)),
          );
        }

        if (path === "/decrypt" && request.method === "POST") {
          const body = (yield* request.json) as { ciphertext?: string };
          return yield* decrypt({
            ciphertext: b64ToBytes(body.ciphertext ?? ""),
          }).pipe(
            Effect.flatMap((dec) =>
              HttpServerResponse.json({
                text: new TextDecoder().decode(Redacted.value(dec.plaintext)),
              }),
            ),
            Effect.catch((error) => fail(error)),
          );
        }

        if (path === "/sign" && request.method === "POST") {
          const body = (yield* request.json) as { text?: string };
          return yield* sign({
            plaintext: new TextEncoder().encode(body.text ?? ""),
          }).pipe(
            Effect.flatMap((signed) =>
              HttpServerResponse.json({
                signature: bytesToB64(signed.signature),
              }),
            ),
            Effect.catch((error) => fail(error)),
          );
        }

        if (path === "/verify" && request.method === "POST") {
          const body = (yield* request.json) as {
            text?: string;
            signature?: string;
          };
          return yield* verify({
            plaintext: new TextEncoder().encode(body.text ?? ""),
            signature: b64ToBytes(body.signature ?? ""),
          }).pipe(
            Effect.flatMap((checked) =>
              HttpServerResponse.json({ valid: checked.valid }),
            ),
            Effect.catch((error) => fail(error)),
          );
        }

        return yield* HttpServerResponse.json({ ok: false }, { status: 404 });
      }),
    };
  }).pipe(
    Effect.provide([
      Fly.GetSecretHttp,
      Fly.ListSecretsHttp,
      Fly.WriteSecretHttp,
      Fly.EncryptHttp,
      Fly.DecryptHttp,
      Fly.SignHttp,
      Fly.VerifyHttp,
    ]),
  ),
) {}
