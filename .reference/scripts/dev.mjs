import { spawn } from "node:child_process"

const frontendDevOrigin = process.env.FRONTEND_DEV_ORIGIN ?? "http://127.0.0.1:5173"
const frontendDevUrl = new URL(frontendDevOrigin)

if (frontendDevUrl.protocol !== "http:" && frontendDevUrl.protocol !== "https:") {
  throw new Error(`FRONTEND_DEV_ORIGIN must use http or https, received ${frontendDevOrigin}`)
}

const frontendHost = process.env.FRONTEND_DEV_HOST ?? frontendDevUrl.hostname
const frontendPort = process.env.FRONTEND_DEV_PORT ?? (frontendDevUrl.port || "5173")
const serverArgs = process.argv.slice(2)

const readFlagValue = (name) => {
  const index = serverArgs.findIndex((arg) => arg === name)
  if (index >= 0) {
    return serverArgs[index + 1]
  }

  const prefixed = serverArgs.find((arg) => arg.startsWith(`${name}=`))
  return prefixed ? prefixed.slice(name.length + 1) : undefined
}

const normalizeBackendHost = (host) => {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "127.0.0.1"
  }
  return host
}

const backendHost = normalizeBackendHost(process.env.HOST ?? readFlagValue("--host"))
const backendPort = process.env.PORT ?? readFlagValue("--port") ?? "8787"
const backendOrigin = process.env.VITE_BACKEND_ORIGIN ?? `http://${backendHost}:${backendPort}`

const children = new Set()
let shuttingDown = false

const stopChildren = (signal = "SIGTERM") => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal)
    }
  }
}

const spawnChild = (command, args, env = {}) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...env
    }
  })

  children.add(child)

  child.on("exit", (code, signal) => {
    stopChildren(signal ?? "SIGTERM")
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })

  return child
}

spawnChild("bun", [
  "run",
  "--filter",
  "@effect-http-ws-cli/web",
  "dev",
  "--",
  "--host",
  frontendHost,
  "--port",
  frontendPort,
  "--strictPort"
], {
  VITE_BACKEND_ORIGIN: backendOrigin
})

spawnChild("node", ["server/src/bin.ts", ...serverArgs], {
  FRONTEND_DEV_ORIGIN: frontendDevOrigin
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopChildren(signal))
}
