import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import * as Http from "node:http"
import { BoundPorts, getContainerRuntimeClient } from "testcontainers"
import { afterAll, beforeAll, vi } from "vitest"
import { pgWaitStrategy, releasePgContainer } from "./utils.ts"

// Less than the existing 30s integration hook limit, including all retry attempts.
const cleanupBudget = "25 seconds"
const testTimeout = 28_000
const releaseOptions = { removeTimeout: "1 second" } as const

describe("PostgreSQL container lifecycle", () => {
  const requests = new Map<string, Array<string>>()
  let interrupted = 0
  const unexpected: Array<string> = []
  let infoRequests = 0
  const server = Http.createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost")
    response.setHeader("Content-Type", "application/json")
    // Bun re-sends a request that fails on a reused keep-alive socket. Fresh
    // connections keep one HTTP request per release attempt on every runtime.
    response.setHeader("Connection", "close")
    if (url.pathname === "/info") {
      infoRequests++
      response.end(JSON.stringify({ ServerVersion: "27.0.0", OperatingSystem: "Docker", OSType: "linux" }))
      return
    }
    const match = /^\/containers\/([^/]+)(\/json|\/exec)?$/.exec(url.pathname)
    if (match === null || !requests.has(match[1])) {
      unexpected.push(request.method + " " + request.url)
      response.writeHead(404).end(JSON.stringify({ message: "Unexpected request" }))
      return
    }
    const id = match[1]
    const steps = requests.get(id)!
    if (request.method === "GET" && match[2] === "/json") {
      steps.push("inspect")
      response.end(
        JSON.stringify({ Id: id, State: { Status: "running", Running: true, Health: { Status: "healthy" } } })
      )
    } else if (request.method === "POST" && match[2] === "/exec") {
      // An exec that never completes, as observed under Deno in CI.
      steps.push("exec")
    } else if (request.method === "DELETE" && match[2] === undefined) {
      steps.push("remove")
      assert.strictEqual(url.searchParams.get("force"), "true")
      assert.strictEqual(url.searchParams.get("v"), "true")
      if (id === "retry-succeeds") {
        if (steps.length === 1) {
          // Close mid-body to deterministically trigger docker-modem's aborted-response path.
          response.flushHeaders()
          response.write("{\"message\":", () => {
            interrupted++
            response.socket!.end()
          })
        } else {
          response.writeHead(404).end(JSON.stringify({ message: `No such container: ${id}` }))
        }
      } else if (id === "remove-fails") {
        if (steps.length === 1) return void response.flushHeaders()
        response.writeHead(500).end(JSON.stringify({ message: "daemon error" }))
      } else {
        unexpected.push(request.method + " " + request.url)
        response.writeHead(404).end(JSON.stringify({ message: "Unexpected request" }))
      }
    } else {
      unexpected.push(request.method + " " + request.url)
      response.writeHead(404).end(JSON.stringify({ message: "Unexpected request" }))
    }
  })

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener")
    vi.stubEnv("DOCKER_HOST", "tcp://127.0.0.1:" + address.port)
    vi.stubEnv("DOCKER_TLS_VERIFY", "0")
    // Initialize the real testcontainers/dockerode client against our daemon.
    // It is cached for this isolated test file; no real Docker is required.
    try {
      await getContainerRuntimeClient()
      assert.strictEqual(infoRequests, 1, "runtime client must use the mock daemon")
    } finally {
      vi.unstubAllEnvs()
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      // Register closure before destroying connections: Bun also stops the
      // listener in closeAllConnections, so closing it afterwards fails.
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  })

  it.live("startup readiness does not depend on docker exec completing", () =>
    Effect.gen(function*() {
      requests.set("exec-hangs", [])
      const client = yield* Effect.promise(() => getContainerRuntimeClient())
      const ports = new BoundPorts()
      ports.setBinding(5432, (server.address() as { port: number }).port)
      const result = yield* Effect.promise(() =>
        pgWaitStrategy().waitUntilReady(client.container.getById("exec-hangs"), ports)
      ).pipe(Effect.timeoutOption("5 seconds"))
      assert.isTrue(Option.isSome(result), "readiness waited on a docker exec that never completed")
      assert.deepStrictEqual(requests.get("exec-hangs"), ["inspect"])
      assert.deepStrictEqual(unexpected, [])
    }), testTimeout)

  const container = (id: string) => {
    requests.set(id, [])
    return id
  }

  it.live("retries an interrupted remove and treats 404 as success", () =>
    Effect.gen(function*() {
      const result = yield* releasePgContainer(container("retry-succeeds"), releaseOptions).pipe(
        Effect.exit,
        Effect.timeoutOption(cleanupBudget)
      )
      assert.strictEqual(interrupted, 1, "daemon did not interrupt the first remove")
      assert.isTrue(Option.isSome(result), "teardown exceeded the cleanup budget")
      if (Option.isNone(result)) return
      assert.isTrue(Exit.isSuccess(result.value), "teardown failed instead of retrying")
      assert.deepStrictEqual(requests.get("retry-succeeds"), ["remove", "remove"])
      assert.deepStrictEqual(unexpected, [])
    }), testTimeout)

  // it.layer runs fixture finalizers under TestClock.
  it.effect("bounds a hung remove and surfaces non-404 failures under TestClock", () =>
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        releasePgContainer(container("remove-fails"), releaseOptions).pipe(Effect.exit)
      )
      const result = yield* Fiber.join(fiber).pipe(Effect.timeoutOption(cleanupBudget), TestClock.withLive)
      assert.isTrue(Option.isSome(result), "teardown hung instead of reporting exhausted retries")
      if (Option.isNone(result)) return yield* Fiber.interrupt(fiber)
      assert.isTrue(Exit.isFailure(result.value), "cleanup failure was suppressed")
      if (Exit.isSuccess(result.value)) return
      assert.isFalse(Cause.hasInterruptsOnly(result.value.cause), "failure must be visible, not just interruption")
      assert.deepStrictEqual(requests.get("remove-fails"), ["remove", "remove", "remove"])
      assert.deepStrictEqual(unexpected, [])
    }), testTimeout)
})
