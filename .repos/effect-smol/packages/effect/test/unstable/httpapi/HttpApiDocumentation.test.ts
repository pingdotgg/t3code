import { assert, describe, it } from "@effect/vitest"
import { Effect, type Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiScalar, HttpApiSwagger, OpenApi } from "effect/unstable/httpapi"

describe("HttpApiScalar", () => {
  it.effect("escapes OpenAPI metadata in its HTML contexts", () =>
    Effect.gen(function*() {
      const title = `Docs "title" </title><script>`
      const injectedTag = `<script id="script-data-injected">`
      const description = `"quoted" 'single' </script >${injectedTag}`
      const Api = HttpApi.make("Docs")
        .annotate(OpenApi.Title, title)
        .annotate(OpenApi.Description, description)

      const html = yield* render(HttpApiScalar.layerCdn(Api))

      assert.ok(html.includes(`<title>Docs "title" &lt;/title&gt;&lt;script&gt;</title>`))
      const escapedDescription =
        `&quot;quoted&quot; &#39;single&#39; &lt;/script &gt;&lt;script id=&quot;script-data-injected&quot;&gt;`
      assert.ok(html.includes(`<meta name="description" content="${escapedDescription}"/>`))
      assert.ok(html.includes(`<meta name="og:description" content="${escapedDescription}"/>`))
      assert.ok(!html.includes(`</script >`))
      assert.deepStrictEqual(extractSpec(html), OpenApi.fromApi(Api))
    }))

  it.effect("encodes CDN versions before interpolating the script source", () =>
    Effect.gen(function*() {
      const version = `1.2.3"></script><script id="injected">`
      const html = yield* render(HttpApiScalar.layerCdn(HttpApi.make("Docs"), { version }))

      assert.ok(html.includes(
        `src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${
          encodeURIComponent(version)
        }/dist/browser/standalone.min.js"`
      ))
      assert.strictEqual(html.match(/<script\b/g)?.length, 2)
      assert.ok(!html.includes(`id="injected"`))
    }))
})

describe("HttpApiSwagger", () => {
  it.effect("escapes script end-tag variants in OpenAPI data", () =>
    Effect.gen(function*() {
      const injectedTag = `<script id="script-data-injected">`
      const Api = HttpApi.make("Docs")
        .annotate(OpenApi.Description, `</script/>${injectedTag}`)

      const html = yield* render(HttpApiSwagger.layer(Api))

      assert.ok(!html.includes(`</script/>`))
      assert.deepStrictEqual(extractSwaggerSpec(html), OpenApi.fromApi(Api))
    }))
})

const render = (layer: Layer.Layer<never, never, HttpRouter.HttpRouter>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
    ({ handler }) =>
      Effect.flatMap(
        Effect.promise(() => handler(new Request("http://test/docs"))),
        (response) => Effect.promise(() => response.text())
      ),
    ({ dispose }) => Effect.promise(dispose)
  )

function extractSpec(html: string): unknown {
  const marker = "        content: "
  const start = html.indexOf(marker)
  assert.notStrictEqual(start, -1)
  const end = html.indexOf("\n      })", start)
  assert.notStrictEqual(end, -1)
  return JSON.parse(html.slice(start + marker.length, end))
}

function extractSwaggerSpec(html: string): unknown {
  const marker = `  <script id="swagger-spec" type="application/json">\n    `
  const start = html.indexOf(marker)
  assert.notStrictEqual(start, -1)
  const end = html.indexOf("\n  </script>", start)
  assert.notStrictEqual(end, -1)
  return JSON.parse(html.slice(start + marker.length, end))
}
