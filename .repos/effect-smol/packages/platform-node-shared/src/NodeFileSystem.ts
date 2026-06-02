/**
 * Shared Node-compatible implementation of Effect's `FileSystem` service.
 *
 * This module adapts Node's `node:fs`, `node:os`, and `node:path` APIs into a
 * `FileSystem` layer for Effect programs running on Node-compatible runtimes.
 * Platform packages use it to provide file and directory I/O, permissions,
 * links, metadata, temporary files and directories, and file watching through
 * the shared `FileSystem` service.
 *
 * **Mental model**
 *
 * {@link layer} installs a process-backed `FileSystem` service. Each operation
 * delegates to the corresponding Node filesystem API, then maps Node failures
 * into `PlatformError` values and invalid arguments into `BadArgument` failures.
 * Paths keep Node's normal behavior: relative paths resolve from the current
 * working directory and platform path rules still apply.
 *
 * **Common tasks**
 *
 * Provide {@link layer} at the Node runtime boundary, then depend on the
 * `FileSystem` service from application code. Use the service for ordinary
 * reads and writes, directory management, metadata inspection, links, temporary
 * resources, and file watching without importing Node's `fs` APIs directly.
 *
 * **Gotchas**
 *
 * Open files are scoped resources with tracked read and write positions; append
 * mode lets the operating system choose the write offset. File watching follows
 * `node:fs.watch` semantics unless a custom watch backend is supplied, so
 * recursive support, event coalescing, and reported paths vary by runtime and
 * platform.
 *
 * @since 4.0.0
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import { effectify } from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Error from "effect/PlatformError"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import * as Crypto from "node:crypto"
import * as NFS from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"
import { handleErrnoException } from "./internal/utils.ts"

const handleBadArgument = (method: string) => (err: unknown) =>
  Error.badArgument({
    module: "FileSystem",
    method,
    description: (err as Error).message ?? String(err)
  })

// == access

const access = ((): FileSystem.FileSystem["access"] => {
  const nodeAccess = effectify(
    NFS.access,
    handleErrnoException("FileSystem", "access"),
    handleBadArgument("access")
  )
  return (path, options) => {
    let mode = NFS.constants.F_OK
    if (options?.readable) {
      mode |= NFS.constants.R_OK
    }
    if (options?.writable) {
      mode |= NFS.constants.W_OK
    }
    return nodeAccess(path, mode)
  }
})()

// == copy

const copy = ((): FileSystem.FileSystem["copy"] => {
  const nodeCp = effectify(
    NFS.cp,
    handleErrnoException("FileSystem", "copy"),
    handleBadArgument("copy")
  )
  return (fromPath, toPath, options) =>
    nodeCp(fromPath, toPath, {
      force: options?.overwrite ?? false,
      preserveTimestamps: options?.preserveTimestamps ?? false,
      recursive: true
    })
})()

// == copyFile

const copyFile = (() => {
  const nodeCopyFile = effectify(
    NFS.copyFile,
    handleErrnoException("FileSystem", "copyFile"),
    handleBadArgument("copyFile")
  )
  return (fromPath: string, toPath: string) => nodeCopyFile(fromPath, toPath)
})()

// == chmod

const chmod = (() => {
  const nodeChmod = effectify(
    NFS.chmod,
    handleErrnoException("FileSystem", "chmod"),
    handleBadArgument("chmod")
  )
  return (path: string, mode: number) => nodeChmod(path, mode)
})()

// == chown

const chown = (() => {
  const nodeChown = effectify(
    NFS.chown,
    handleErrnoException("FileSystem", "chown"),
    handleBadArgument("chown")
  )
  return (path: string, uid: number, gid: number) => nodeChown(path, uid, gid)
})()

// == link

const link = (() => {
  const nodeLink = effectify(
    NFS.link,
    handleErrnoException("FileSystem", "link"),
    handleBadArgument("link")
  )
  return (existingPath: string, newPath: string) => nodeLink(existingPath, newPath)
})()

// == makeDirectory

const makeDirectory = ((): FileSystem.FileSystem["makeDirectory"] => {
  const nodeMkdir = effectify(
    NFS.mkdir,
    handleErrnoException("FileSystem", "makeDirectory"),
    handleBadArgument("makeDirectory")
  )
  return (path, options) =>
    nodeMkdir(path, {
      recursive: options?.recursive ?? false,
      mode: options?.mode
    })
})()

// == makeTempDirectory

const makeTempDirectoryFactory = (method: string): FileSystem.FileSystem["makeTempDirectory"] => {
  const nodeMkdtemp = effectify(
    NFS.mkdtemp,
    handleErrnoException("FileSystem", method),
    handleBadArgument(method)
  )
  return (options) =>
    Effect.suspend(() => {
      const prefix = options?.prefix ?? ""
      const directory = typeof options?.directory === "string"
        ? Path.join(options.directory, ".")
        : OS.tmpdir()

      return nodeMkdtemp(prefix ? Path.join(directory, prefix) : directory + "/")
    })
}
const makeTempDirectory = makeTempDirectoryFactory("makeTempDirectory")

// == remove

const removeFactory = (method: string): FileSystem.FileSystem["remove"] => {
  const nodeRm = effectify(
    NFS.rm,
    handleErrnoException("FileSystem", method),
    handleBadArgument(method)
  )
  return (path, options) =>
    nodeRm(
      path,
      { recursive: options?.recursive ?? false, force: options?.force ?? false }
    )
}
const remove = removeFactory("remove")

// == makeTempDirectoryScoped

const makeTempDirectoryScoped = ((): FileSystem.FileSystem["makeTempDirectoryScoped"] => {
  const makeDirectory = makeTempDirectoryFactory("makeTempDirectoryScoped")
  const removeDirectory = removeFactory("makeTempDirectoryScoped")
  return (options) =>
    Effect.acquireRelease(
      makeDirectory(options),
      (directory) => Effect.orDie(removeDirectory(directory, { recursive: true }))
    )
})()

// == open

const openFactory = (method: string): FileSystem.FileSystem["open"] => {
  const nodeOpen = effectify(
    NFS.open,
    handleErrnoException("FileSystem", method),
    handleBadArgument(method)
  )
  const nodeClose = effectify(
    NFS.close,
    handleErrnoException("FileSystem", method),
    handleBadArgument(method)
  )

  return (path, options) =>
    pipe(
      Effect.acquireRelease(
        nodeOpen(path, options?.flag ?? "r", options?.mode),
        (fd) => Effect.orDie(nodeClose(fd))
      ),
      Effect.map((fd) => makeFile(FileSystem.FileDescriptor(fd), options?.flag?.startsWith("a") ?? false))
    )
}
const open = openFactory("open")

const makeFile = (() => {
  const nodeReadFactory = (method: string) =>
    effectify(
      NFS.read,
      handleErrnoException("FileSystem", method),
      handleBadArgument(method)
    )
  const nodeRead = nodeReadFactory("read")
  const nodeReadAlloc = nodeReadFactory("readAlloc")
  const nodeStat = effectify(
    NFS.fstat,
    handleErrnoException("FileSystem", "stat"),
    handleBadArgument("stat")
  )
  const nodeTruncate = effectify(
    NFS.ftruncate,
    handleErrnoException("FileSystem", "truncate"),
    handleBadArgument("truncate")
  )

  const nodeSync = effectify(
    NFS.fsync,
    handleErrnoException("FileSystem", "sync"),
    handleBadArgument("sync")
  )

  const nodeWriteFactory = (method: string) =>
    effectify(
      NFS.write,
      handleErrnoException("FileSystem", method),
      handleBadArgument(method)
    )
  const nodeWrite = nodeWriteFactory("write")
  const nodeWriteAll = nodeWriteFactory("writeAll")

  class FileImpl implements FileSystem.File {
    readonly [FileSystem.FileTypeId]: typeof FileSystem.FileTypeId
    readonly fd: FileSystem.File.Descriptor
    private readonly append: boolean

    private position: bigint = BigInt(0)

    constructor(
      fd: FileSystem.File.Descriptor,
      append: boolean
    ) {
      this[FileSystem.FileTypeId] = FileSystem.FileTypeId
      this.fd = fd
      this.append = append
    }

    get stat() {
      return Effect.map(nodeStat(this.fd), makeFileInfo)
    }

    get sync() {
      return nodeSync(this.fd)
    }

    seek(offset: FileSystem.SizeInput, from: FileSystem.SeekMode) {
      const offsetSize = FileSystem.Size(offset)
      return Effect.sync(() => {
        if (from === "start") {
          this.position = offsetSize
        } else if (from === "current") {
          this.position = this.position + offsetSize
        }

        return this.position
      })
    }

    read(buffer: Uint8Array) {
      return Effect.suspend(() => {
        const position = this.position
        return Effect.map(
          nodeRead(this.fd, { buffer, position }),
          (bytesRead) => {
            const sizeRead = FileSystem.Size(bytesRead)
            this.position = position + sizeRead
            return sizeRead
          }
        )
      })
    }

    readAlloc(size: FileSystem.SizeInput) {
      const sizeNumber = Number(size)
      return Effect.suspend(() => {
        const buffer = Buffer.allocUnsafeSlow(sizeNumber)
        const position = this.position
        return Effect.map(
          nodeReadAlloc(this.fd, { buffer, position }),
          (bytesRead): Option.Option<Buffer> => {
            if (bytesRead === 0) {
              return Option.none()
            }

            this.position = position + BigInt(bytesRead)
            if (bytesRead === sizeNumber) {
              return Option.some(buffer)
            }

            const dst = Buffer.allocUnsafeSlow(bytesRead)
            buffer.copy(dst, 0, 0, bytesRead)
            return Option.some(dst)
          }
        )
      })
    }

    truncate(length?: FileSystem.SizeInput) {
      return Effect.map(nodeTruncate(this.fd, length ? Number(length) : undefined), () => {
        if (!this.append) {
          const len = BigInt(length ?? 0)
          if (this.position > len) {
            this.position = len
          }
        }
      })
    }

    write(buffer: Uint8Array) {
      return Effect.suspend(() => {
        const position = this.position
        return Effect.map(
          nodeWrite(this.fd, buffer, undefined, undefined, this.append ? undefined : Number(position)),
          (bytesWritten) => {
            const sizeWritten = FileSystem.Size(bytesWritten)
            if (!this.append) {
              this.position = position + sizeWritten
            }
            return sizeWritten
          }
        )
      })
    }

    private writeAllChunk(buffer: Uint8Array): Effect.Effect<void, Error.PlatformError> {
      return Effect.suspend(() => {
        const position = this.position
        return Effect.flatMap(
          nodeWriteAll(this.fd, buffer, undefined, undefined, this.append ? undefined : Number(position)),
          (bytesWritten) => {
            if (bytesWritten === 0) {
              return Effect.fail(
                Error.systemError({
                  module: "FileSystem",
                  method: "writeAll",
                  _tag: "WriteZero",
                  pathOrDescriptor: this.fd,
                  description: "write returned 0 bytes written"
                })
              )
            }

            if (!this.append) {
              this.position = position + BigInt(bytesWritten)
            }

            return bytesWritten < buffer.length ? this.writeAllChunk(buffer.subarray(bytesWritten)) : Effect.void
          }
        )
      })
    }

    writeAll(buffer: Uint8Array) {
      return this.writeAllChunk(buffer)
    }
  }

  return (fd: FileSystem.File.Descriptor, append: boolean): FileSystem.File => new FileImpl(fd, append)
})()

// == makeTempFile

const makeTempFileFactory = (method: string): FileSystem.FileSystem["makeTempFile"] => {
  const makeDirectory = makeTempDirectoryFactory(method)
  return Effect.fnUntraced(function*(options) {
    const directory = yield* makeDirectory(options)
    const random = Crypto.randomBytes(6).toString("hex")
    const name = Path.join(directory, options?.suffix ? `${random}${options.suffix}` : random)
    yield* writeFile(name, new Uint8Array(0))
    return name
  })
}
const makeTempFile = makeTempFileFactory("makeTempFile")

// == makeTempFileScoped

const makeTempFileScoped = ((): FileSystem.FileSystem["makeTempFileScoped"] => {
  const makeFile = makeTempFileFactory("makeTempFileScoped")
  const removeDirectory = removeFactory("makeTempFileScoped")
  return (options) =>
    Effect.acquireRelease(
      makeFile(options),
      (file) => Effect.orDie(removeDirectory(Path.dirname(file), { recursive: true }))
    )
})()

// == readDirectory

const readDirectory: FileSystem.FileSystem["readDirectory"] = (path, options) =>
  Effect.tryPromise({
    try: () => NFS.promises.readdir(path, options),
    catch: (err) => handleErrnoException("FileSystem", "readDirectory")(err as any, [path])
  })

// == readFile

const readFile = (path: string) =>
  Effect.callback<Uint8Array, Error.PlatformError>((resume, signal) => {
    try {
      NFS.readFile(path, { signal }, (err, data) => {
        if (err) {
          resume(Effect.fail(handleErrnoException("FileSystem", "readFile")(err, [path])))
        } else {
          resume(Effect.succeed(data))
        }
      })
    } catch (err) {
      resume(Effect.fail(handleBadArgument("readFile")(err)))
    }
  })

// == readLink

const readLink = (() => {
  const nodeReadLink = effectify(
    NFS.readlink,
    handleErrnoException("FileSystem", "readLink"),
    handleBadArgument("readLink")
  )
  return (path: string) => nodeReadLink(path)
})()

// == realPath

const realPath = (() => {
  const nodeRealPath = effectify(
    NFS.realpath,
    handleErrnoException("FileSystem", "realPath"),
    handleBadArgument("realPath")
  )
  return (path: string) => nodeRealPath(path)
})()

// == rename

const rename = (() => {
  const nodeRename = effectify(
    NFS.rename,
    handleErrnoException("FileSystem", "rename"),
    handleBadArgument("rename")
  )
  return (oldPath: string, newPath: string) => nodeRename(oldPath, newPath)
})()

// == stat

const makeFileInfo = (stat: NFS.Stats): FileSystem.File.Info => ({
  type: stat.isFile() ?
    "File" :
    stat.isDirectory() ?
    "Directory" :
    stat.isSymbolicLink() ?
    "SymbolicLink" :
    stat.isBlockDevice() ?
    "BlockDevice" :
    stat.isCharacterDevice() ?
    "CharacterDevice" :
    stat.isFIFO() ?
    "FIFO" :
    stat.isSocket() ?
    "Socket" :
    "Unknown",
  mtime: Option.fromNullishOr(stat.mtime),
  atime: Option.fromNullishOr(stat.atime),
  birthtime: Option.fromNullishOr(stat.birthtime),
  dev: stat.dev,
  rdev: Option.fromNullishOr(stat.rdev),
  ino: Option.fromNullishOr(stat.ino),
  mode: stat.mode,
  nlink: Option.fromNullishOr(stat.nlink),
  uid: Option.fromNullishOr(stat.uid),
  gid: Option.fromNullishOr(stat.gid),
  size: FileSystem.Size(stat.size),
  blksize: stat.blksize !== undefined ? Option.some(FileSystem.Size(stat.blksize)) : Option.none(),
  blocks: Option.fromNullishOr(stat.blocks)
})
const stat = (() => {
  const nodeStat = effectify(
    NFS.stat,
    handleErrnoException("FileSystem", "stat"),
    handleBadArgument("stat")
  )
  return (path: string) => Effect.map(nodeStat(path), makeFileInfo)
})()

// == symlink

const symlink = (() => {
  const nodeSymlink = effectify(
    NFS.symlink,
    handleErrnoException("FileSystem", "symlink"),
    handleBadArgument("symlink")
  )
  return (target: string, path: string) => nodeSymlink(target, path)
})()

// == truncate

const truncate = (() => {
  const nodeTruncate = effectify(
    NFS.truncate,
    handleErrnoException("FileSystem", "truncate"),
    handleBadArgument("truncate")
  )
  return (path: string, length?: FileSystem.SizeInput) =>
    nodeTruncate(path, length !== undefined ? Number(length) : undefined)
})()

// == utimes

const utimes = (() => {
  const nodeUtimes = effectify(
    NFS.utimes,
    handleErrnoException("FileSystem", "utime"),
    handleBadArgument("utime")
  )
  return (path: string, atime: number | Date, mtime: number | Date) => nodeUtimes(path, atime, mtime)
})()

// == watch

const watchNode = (path: string) =>
  Stream.callback<FileSystem.WatchEvent, Error.PlatformError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = NFS.watch(path, {
          recursive: true
        }, (event, path) => {
          if (!path) return
          switch (event) {
            case "rename": {
              Effect.runFork(Effect.matchEffect(stat(path), {
                onSuccess: (_) => Queue.offer(queue, { _tag: "Create", path }),
                onFailure: (_) => Queue.offer(queue, { _tag: "Remove", path })
              }))
              return
            }
            case "change": {
              Queue.offerUnsafe(queue, { _tag: "Update", path })
              return
            }
          }
        })
        watcher.on("error", (error) => {
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(
              Error.systemError({
                module: "FileSystem",
                _tag: "Unknown",
                method: "watch",
                pathOrDescriptor: path,
                cause: error
              })
            )
          )
        })
        watcher.on("close", () => {
          Queue.endUnsafe(queue)
        })
        return watcher
      }),
      (watcher) => Effect.sync(() => watcher.close())
    )
  )

const watch = (backend: Option.Option<FileSystem.WatchBackend["Service"]>, path: string) =>
  stat(path).pipe(
    Effect.map((stat) =>
      backend.pipe(
        Option.flatMap((_) => _.register(path, stat)),
        Option.getOrElse(() => watchNode(path))
      )
    ),
    Stream.unwrap
  )

// == writeFile

const writeFile: FileSystem.FileSystem["writeFile"] = (path, data, options) =>
  Effect.callback<void, Error.PlatformError>((resume, signal) => {
    try {
      NFS.writeFile(path, data, {
        signal,
        flag: options?.flag,
        mode: options?.mode
      }, (err) => {
        if (err) {
          resume(Effect.fail(handleErrnoException("FileSystem", "writeFile")(err, [path])))
        } else {
          resume(Effect.void)
        }
      })
    } catch (err) {
      resume(Effect.fail(handleBadArgument("writeFile")(err)))
    }
  })

const makeFileSystem = Effect.map(Effect.serviceOption(FileSystem.WatchBackend), (backend) =>
  FileSystem.make({
    access,
    chmod,
    chown,
    copy,
    copyFile,
    link,
    makeDirectory,
    makeTempDirectory,
    makeTempDirectoryScoped,
    makeTempFile,
    makeTempFileScoped,
    open,
    readDirectory,
    readFile,
    readLink,
    realPath,
    remove,
    rename,
    stat,
    symlink,
    truncate,
    utimes,
    watch(path) {
      return watch(backend, path)
    },
    writeFile
  }))

/**
 * Provides the `FileSystem` service backed by Node filesystem APIs, including
 * file operations, directory operations, links, metadata, and file watching.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<FileSystem.FileSystem> = Layer.effect(FileSystem.FileSystem)(makeFileSystem)
