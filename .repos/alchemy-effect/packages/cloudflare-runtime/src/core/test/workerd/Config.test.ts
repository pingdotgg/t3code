import { describe, expect, it } from "@effect/vitest";
import { Message } from "capnp-es";
import * as WorkerdConfig from "../../workerd/Config.ts";
import { Config as CapnpConfig } from "../../workerd/internal/config.capnp.ts";
import { serializeConfig } from "../../workerd/internal/config.serialize.ts";

describe("workerd/Config", () => {
  it("kVoid is a unique symbol", () => {
    expect(typeof WorkerdConfig.kVoid).toBe("symbol");
    expect(WorkerdConfig.kVoid.description).toBe("kVoid");
  });

  describe("serializeConfig", () => {
    it("serializes a minimal valid config", () => {
      const buffer = serializeConfig({
        sockets: [
          {
            name: "http",
            address: "127.0.0.1:0",
            service: { name: "user" },
          },
        ],
        services: [
          {
            name: "user",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                {
                  name: "main.js",
                  esModule:
                    "export default { fetch: () => new Response('ok') };",
                },
              ],
            },
          },
        ],
      });
      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it("encodes void bindings using kVoid", () => {
      expect(() =>
        serializeConfig({
          services: [
            {
              name: "user",
              worker: {
                modules: [{ name: "main.js", esModule: "export default {}" }],
                bindings: [{ name: "EVAL", unsafeEval: WorkerdConfig.kVoid }],
              },
            },
          ],
        }),
      ).not.toThrow();
    });

    it("handles kVoid + Uint8Array fields", () => {
      const config: WorkerdConfig.Config = {
        services: [
          {
            name: "user",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [
                { name: "data.bin", data: new Uint8Array([1, 2, 3, 4, 5]) },
                { name: "main.js", esModule: "export default {}" },
              ],
              bindings: [{ name: "EVAL", unsafeEval: WorkerdConfig.kVoid }],
              durableObjectNamespaces: [
                { className: "Foo", ephemeralLocal: WorkerdConfig.kVoid },
              ],
            },
          },
        ],
      };
      const buffer = serializeConfig(config);
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it("encodes container-backed Durable Object namespaces", () => {
      const config: WorkerdConfig.Config = {
        services: [
          {
            name: "user",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [{ name: "main.js", esModule: "export default {}" }],
              durableObjectNamespaces: [
                {
                  className: "Foo",
                  uniqueKey: "foo",
                  container: { imageName: "my-image:dev" },
                },
              ],
              containerEngine: {
                localDocker: {
                  socketPath: "unix:///var/run/docker.sock",
                  containerEgressInterceptorImage:
                    "cloudflare/proxy-everything:latest",
                },
              },
            },
          },
        ],
      };
      const buffer = serializeConfig(config);
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it("handles extensions and disk services", () => {
      const config: WorkerdConfig.Config = {
        services: [{ name: "files", disk: { path: "/tmp", writable: false } }],
        extensions: [
          {
            modules: [
              {
                name: "ext.js",
                internal: true,
                esModule: "export const x = 1;",
              },
            ],
          },
        ],
      };
      const buffer = serializeConfig(config);
      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it("throws a useful error when a `json` binding is given an object instead of a string", () => {
      expect(() =>
        serializeConfig({
          services: [
            {
              name: "user",
              worker: {
                modules: [{ name: "main.js", esModule: "export default {}" }],
                bindings: [
                  {
                    name: "CONFIG",
                    // BUG: this should be JSON.stringify(...). The serializer
                    // must surface a helpful error rather than the cryptic
                    // `anyStruct[capitalized] is not a function`.
                    json: { foo: "bar" } as unknown as string,
                  },
                ],
              },
            },
          ],
        }),
      ).toThrow(/services\.0\.worker\.bindings\.0\.json/);
    });

    it("round-trips the container engine and per-DO container image", () => {
      const config: WorkerdConfig.Config = {
        services: [
          {
            name: "user",
            worker: {
              compatibilityDate: "2026-03-10",
              modules: [{ name: "main.js", esModule: "export default {}" }],
              durableObjectNamespaces: [
                {
                  className: "MyContainer",
                  uniqueKey: "user-MyContainer",
                  container: {
                    imageName: "cloudflare-dev/mycontainer:abc12345",
                  },
                },
              ],
              containerEngine: {
                localDocker: {
                  socketPath: "unix:///var/run/docker.sock",
                  containerEgressInterceptorImage:
                    "cloudflare/proxy-everything:test",
                },
              },
            },
          },
        ],
      };

      const buffer = serializeConfig(config);
      const decoded = new Message(buffer, false).getRoot(CapnpConfig);
      const worker = decoded.services.get(0).worker;

      expect(worker.containerEngine.localDocker.socketPath).toBe(
        "unix:///var/run/docker.sock",
      );
      expect(
        worker.containerEngine.localDocker.containerEgressInterceptorImage,
      ).toBe("cloudflare/proxy-everything:test");

      const namespace = worker.durableObjectNamespaces.get(0);
      expect(namespace.className).toBe("MyContainer");
      expect(namespace.container.imageName).toBe(
        "cloudflare-dev/mycontainer:abc12345",
      );
    });

    it("throws a useful error when a key does not exist on the capnp struct", () => {
      expect(() =>
        serializeConfig({
          services: [
            {
              name: "user",
              worker: {
                modules: [{ name: "main.js", esModule: "export default {}" }],
                // @ts-expect-error - intentionally invalid key
                bindings: [{ name: "X", notARealField: "value" }],
              },
            },
          ],
        }),
      ).toThrow(/notARealField|NotARealField/);
    });
  });
});
