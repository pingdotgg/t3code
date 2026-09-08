import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform"
import * as NodePathLayer from "@effect/platform-node/NodePath"
import { assert, describe, it } from "@effect/vitest"
import * as Layer from "effect/Layer"
import { HttpRouter, HttpStaticServer } from "effect/unstable/http"
import { copyFile, cp, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"

const fixturesRoot = fileURLToPath(new URL("./fixtures/http-static-server", import.meta.url))
const fixturesOutsideFile = fileURLToPath(new URL("./fixtures/http-static-server-outside.txt", import.meta.url))

const staticFilesLayer = Layer.mergeAll(
  NodePathLayer.layer,
  NodeFileSystem.layer,
  NodeHttpPlatform.layer
)

const makeHandler = (
  root: string,
  options: Omit<Parameters<typeof HttpStaticServer.make>[0], "root"> = {}
) =>
  HttpRouter.toWebHandler(
    HttpStaticServer.layer({
      root,
      ...options
    }).pipe(Layer.provideMerge(staticFilesLayer)),
    { disableLogger: true }
  )

const withStaticFiles = async (
  run: (context: {
    readonly handler: (request: Request) => Promise<Response>
    readonly root: string
    readonly outsideFile: string
  }) => Promise<void>,
  options: Omit<Parameters<typeof HttpStaticServer.make>[0], "root"> = {}
) => {
  const temporaryRoot = await mkdtemp(NodePath.join(tmpdir(), "effect-http-static-server-"))
  const root = NodePath.join(temporaryRoot, "root")
  const outsideFile = NodePath.join(temporaryRoot, NodePath.basename(fixturesOutsideFile))

  await Promise.all([
    cp(fixturesRoot, root, { recursive: true }),
    copyFile(fixturesOutsideFile, outsideFile)
  ])

  const { handler, dispose } = makeHandler(root, options)
  try {
    await run({ handler, root, outsideFile })
  } finally {
    await dispose()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

describe("HttpStaticServer", () => {
  it("serves files with expected content type and body", async () => {
    await withStaticFiles(async ({ handler }) => {
      const response = await handler(new Request("http://localhost/hello.txt"))
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("content-type"), "text/plain; charset=utf-8")
      assert.strictEqual((await response.text()).trimEnd(), "hello static file")
    })
  })

  it("serves default index file for directory paths", async () => {
    await withStaticFiles(async ({ handler }) => {
      const response = await handler(new Request("http://localhost/guide"))
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("content-type"), "text/html; charset=utf-8")
      assert.strictEqual((await response.text()).trimEnd(), "<html><body>guide index</body></html>")
    })
  })

  it("supports custom index file and disabled index fallback", async () => {
    await withStaticFiles(async ({ handler }) => {
      const response = await handler(new Request("http://localhost/custom"))
      assert.strictEqual(response.status, 200)
      assert.strictEqual((await response.text()).trimEnd(), "<html><body>custom home</body></html>")
    }, { index: "home.html" })

    await withStaticFiles(async ({ handler }) => {
      const response = await handler(new Request("http://localhost/custom"))
      assert.strictEqual(response.status, 404)
    }, { index: undefined })
  })

  it("returns 304 for If-None-Match exact, weak, and wildcard", async () => {
    await withStaticFiles(async ({ handler }) => {
      const warmup = await handler(new Request("http://localhost/conditional.txt"))
      const etag = warmup.headers.get("etag")
      assert.notStrictEqual(etag, null)
      if (etag === null) {
        throw new Error("missing etag")
      }
      const weakComparable = etag.startsWith("W/") ? etag.slice(2) : `W/${etag}`

      const exact = await handler(
        new Request("http://localhost/conditional.txt", { headers: { "If-None-Match": etag } })
      )
      const weak = await handler(
        new Request("http://localhost/conditional.txt", { headers: { "If-None-Match": weakComparable } })
      )
      const any = await handler(new Request("http://localhost/conditional.txt", { headers: { "If-None-Match": "*" } }))

      assert.deepStrictEqual([exact.status, weak.status, any.status], [304, 304, 304])
      assert.strictEqual(exact.headers.get("etag"), etag)
      assert.strictEqual(exact.headers.get("cache-control"), "public, max-age=60")
      assert.strictEqual(exact.headers.get("content-type"), null)
      assert.strictEqual(exact.headers.get("content-length"), null)
    }, { cacheControl: "public, max-age=60" })
  })

  it("returns 304 for If-Modified-Since and 200 when file changed", async () => {
    await withStaticFiles(async ({ handler, root }) => {
      const first = await handler(new Request("http://localhost/conditional.txt"))
      const lastModified = first.headers.get("last-modified")
      assert.notStrictEqual(lastModified, null)
      if (lastModified === null) {
        throw new Error("missing last-modified")
      }

      const notModified = await handler(
        new Request("http://localhost/conditional.txt", {
          headers: {
            "If-Modified-Since": lastModified
          }
        })
      )
      assert.strictEqual(notModified.status, 304)

      const conditionalFile = NodePath.join(root, "conditional.txt")
      await writeFile(conditionalFile, "updated conditional body")
      const updatedTime = new Date(Date.now() + 10_000)
      await utimes(conditionalFile, updatedTime, updatedTime)

      const modified = await handler(
        new Request("http://localhost/conditional.txt", {
          headers: {
            "If-Modified-Since": lastModified
          }
        })
      )
      assert.strictEqual(modified.status, 200)
      assert.strictEqual(await modified.text(), "updated conditional body")
    })
  })

  it("handles range requests for valid, invalid, and malformed headers", async () => {
    await withStaticFiles(async ({ handler }) => {
      const fullBody = await handler(new Request("http://localhost/range.txt")).then((response) => response.text())
      const fileSize = fullBody.length

      const first = await handler(new Request("http://localhost/range.txt", { headers: { Range: "bytes=0-10" } }))
      assert.strictEqual(first.status, 206)
      assert.strictEqual(first.headers.get("content-range"), `bytes 0-10/${fileSize}`)
      assert.strictEqual(await first.text(), "0123456789a")

      const openEnded = await handler(new Request("http://localhost/range.txt", { headers: { Range: "bytes=5-" } }))
      assert.strictEqual(openEnded.status, 206)
      assert.strictEqual(openEnded.headers.get("content-range"), `bytes 5-${fileSize - 1}/${fileSize}`)
      assert.strictEqual(await openEnded.text(), fullBody.slice(5))

      const suffix = await handler(new Request("http://localhost/range.txt", { headers: { Range: "bytes=-10" } }))
      assert.strictEqual(suffix.status, 206)
      assert.strictEqual(suffix.headers.get("content-range"), `bytes ${fileSize - 10}-${fileSize - 1}/${fileSize}`)
      assert.strictEqual(await suffix.text(), fullBody.slice(-10))

      const invalid = await handler(new Request("http://localhost/range.txt", { headers: { Range: "bytes=100-200" } }))
      assert.strictEqual(invalid.status, 416)
      assert.strictEqual(invalid.headers.get("content-range"), `bytes */${fileSize}`)

      const malformed = await handler(new Request("http://localhost/range.txt", { headers: { Range: "bytes=abc" } }))
      assert.strictEqual(malformed.status, 200)
      assert.strictEqual(await malformed.text(), fullBody)
    })
  })

  it("handles SPA fallback for html accept and missing routes", async () => {
    await withStaticFiles(async ({ handler }) => {
      const htmlFallback = await handler(new Request("http://localhost/missing", { headers: { accept: "text/html" } }))
      assert.strictEqual(htmlFallback.status, 200)
      assert.strictEqual((await htmlFallback.text()).trimEnd(), "<html><body>root index</body></html>")

      const withExtension = await handler(
        new Request("http://localhost/missing.js", { headers: { accept: "text/html" } })
      )
      assert.strictEqual(withExtension.status, 404)

      const withoutHtmlAccept = await handler(
        new Request("http://localhost/missing", { headers: { accept: "application/json" } })
      )
      assert.strictEqual(withoutHtmlAccept.status, 404)
    }, { spa: true, index: "index.html" })
  })

  it("rejects directory traversal attempts", async () => {
    await withStaticFiles(async ({ handler, outsideFile }) => {
      const plainTraversal = await handler(new Request("http://localhost/../../../etc/passwd"))
      const encodedTraversal = await handler(new Request("http://localhost/..%2F..%2Fetc%2Fpasswd"))
      const encodedExistingParentFileTraversal = await handler(
        new Request(`http://localhost/..%2F${encodeURIComponent(NodePath.basename(outsideFile))}`)
      )

      assert.deepStrictEqual([
        plainTraversal.status,
        encodedTraversal.status,
        encodedExistingParentFileTraversal.status
      ], [
        404,
        404,
        404
      ])
    })
  })

  it("rejects null bytes and malformed uri encoding", async () => {
    await withStaticFiles(async ({ handler }) => {
      const nullByte = await handler(new Request("http://localhost/null%00byte.txt"))
      const malformed = await handler(new Request("http://localhost/%E0%A4%A"))

      assert.deepStrictEqual([nullByte.status, malformed.status], [404, 404])
    })
  })

  it("applies custom mime types and cache-control", async () => {
    await withStaticFiles(async ({ handler }) => {
      const response = await handler(new Request("http://localhost/hello.txt"))
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("content-type"), "application/x-custom-text")
      assert.strictEqual(response.headers.get("cache-control"), "public, max-age=120")
    }, {
      cacheControl: "public, max-age=120",
      mimeTypes: {
        txt: "application/x-custom-text"
      }
    })
  })

  it("uses application/octet-stream for unknown extension and 404 for missing file", async () => {
    await withStaticFiles(async ({ handler }) => {
      const unknown = await handler(new Request("http://localhost/file.binx"))
      assert.strictEqual(unknown.status, 200)
      assert.strictEqual(unknown.headers.get("content-type"), "application/octet-stream")

      const missing = await handler(new Request("http://localhost/does-not-exist.txt"))
      assert.strictEqual(missing.status, 404)
    })
  })
})
