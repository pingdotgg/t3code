import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { OtlpResource } from "effect/unstable/observability"

const attributesRecord = (resource: OtlpResource.Resource): Record<string, string | null | undefined> =>
  Object.fromEntries(resource.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))

describe("OtlpResource", () => {
  describe("fromConfig", () => {
    it.effect("uses OTEL service variables before explicit options", () =>
      Effect.gen(function*() {
        const resource = yield* OtlpResource.fromConfig({
          serviceName: "explicit-service",
          serviceVersion: "explicit-version",
          attributes: {
            "custom.attribute": "explicit"
          }
        })

        assert.deepStrictEqual(attributesRecord(resource), {
          "custom.attribute": "explicit",
          "service.name": "env-service",
          "service.version": "env-version"
        })
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              OTEL_SERVICE_NAME: "env-service",
              OTEL_SERVICE_VERSION: "env-version"
            }
          })
        )
      ))

    it.effect("uses OTEL resource attributes before explicit options", () =>
      Effect.gen(function*() {
        const resource = yield* OtlpResource.fromConfig({
          serviceName: "explicit-service",
          serviceVersion: "explicit-version",
          attributes: {
            "custom.attribute": "explicit",
            "service.name": "explicit-attribute-service",
            "service.version": "explicit-attribute-version"
          }
        })

        assert.deepStrictEqual(attributesRecord(resource), {
          "custom.attribute": "env",
          "service.name": "env-attribute-service",
          "service.version": "env-attribute-version"
        })
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              OTEL_RESOURCE_ATTRIBUTES:
                "service.name=env-attribute-service,service.version=env-attribute-version,custom.attribute=env"
            }
          })
        )
      ))

    it.effect("omits service.version when it is not configured", () =>
      Effect.gen(function*() {
        const resource = yield* OtlpResource.fromConfig({
          serviceName: "explicit-service"
        })

        assert.deepStrictEqual(attributesRecord(resource), {
          "service.name": "explicit-service"
        })
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {}
          })
        )
      ))
  })
})
