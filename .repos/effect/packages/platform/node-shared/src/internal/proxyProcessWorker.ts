/**
 * The program of the proxy process. `NodeChildProcessProxy.run` calls
 * {@link run} directly, and the default launcher runs it with
 * `node --input-type=module -e`, from the source text that
 * `scripts/generateProxyProcessSource.ts` generates from this module. So it
 * must not import anything but Node.js builtins.
 *
 * The application sends the socket path and token in its first message, and
 * the proxy process answers `Ready`. For each piped fd of a command it
 * connects to the application's socket, identifies the socket with a header,
 * and hands it to the command as that fd, so no output passes through the
 * proxy process.
 *
 * @internal
 */
import * as ChildProcess from "node:child_process"
import * as Net from "node:net"
import * as Util from "node:util"

/** @internal */
export const tokenLength = 16
/** @internal */
export const headerLength = tokenLength + 8

type SocketWithHandle = Net.Socket & {
  readonly _handle?: { setBlocking(blocking: boolean): number } | null
}

type Request = {
  readonly id: number
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly options: ChildProcess.SpawnOptions & { readonly stdio: ReadonlyArray<string> }
}

/** @internal */
export const run = (): void => {
  if (typeof process.send !== "function") {
    process.stderr.write("The proxy process must be started by NodeChildProcessSpawner.layerProxyProcess\n")
    process.exitCode = 1
    return
  }
  const send = (message: object) => {
    if (process.connected) process.send?.(message)
  }
  const serializeError = (error: NodeJS.ErrnoException) => ({
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path
  })
  const connect = (socketPath: string, token: string, id: number, fd: number) =>
    new Promise<Net.Socket>((resolve, reject) => {
      const socket = Net.connect(socketPath)
      socket.pause()
      socket.once("error", reject)
      socket.once("connect", () => {
        const header = Buffer.alloc(headerLength)
        header.write(token, "hex")
        header.writeUInt32BE(id, tokenLength)
        header.writeUInt32BE(fd, tokenLength + 4)
        socket.write(header, (error) => error ? reject(error) : resolve(socket))
      })
    })
  const spawn = async (socketPath: string, token: string, { args, command, id, options }: Request) => {
    const stdio = await Promise.allSettled(
      options.stdio.map((mode, fd) => mode === "pipe" ? connect(socketPath, token, id, fd) : mode)
    )
    const values = stdio.map((result) => result.status === "fulfilled" ? result.value : undefined)
    const sockets = values.filter((value) => value instanceof Net.Socket)
    try {
      const failure = stdio.find((result) => result.status === "rejected")
      if (failure) throw failure.reason
      // The command shares the file status flags of each socket, and libuv only
      // makes fds 0 to 2 blocking
      for (const socket of sockets) {
        // A socket that has lost its handle is rejected by `spawn`
        const errno = (socket as SocketWithHandle)._handle?.setBlocking(true)
        if (errno) throw new Error(`setBlocking failed: ${Util.getSystemErrorName(errno)}`)
      }
      const child = ChildProcess.spawn(command, args, { ...options, stdio: values as Array<Net.Socket | "inherit"> })
      child.on("error", (error) => send({ _tag: "Error", id, error: serializeError(error) }))
      child.on("spawn", () => send({ _tag: "Spawned", id, pid: child.pid }))
      child.on("exit", (code, signal) => send({ _tag: "Exit", id, code, signal }))
    } catch (error) {
      send({ _tag: "Error", id, error: serializeError(error as NodeJS.ErrnoException) })
    } finally {
      // The command holds its own copies of the sockets
      for (const socket of sockets) socket.destroy()
    }
  }
  // The application decides how to handle these. Once it has disconnected,
  // the proxy process exits when its commands have exited.
  process.on("SIGINT", () => {})
  process.on("SIGTERM", () => {})
  process.once("message", ({ socketPath, token }: { readonly socketPath: string; readonly token: string }) => {
    process.on("message", (request: Request) => spawn(socketPath, token, request))
    send({ _tag: "Ready" })
  })
}
