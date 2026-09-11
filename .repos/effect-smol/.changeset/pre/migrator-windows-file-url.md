---
"effect": patch
---

Import migrations through a file URL in `Migrator.fromFileSystem`, so absolute Windows paths are accepted by the ESM loader.

Previously the directory and file name were passed to `import` as a plain path. On Windows that produced a specifier such as `D:\migrations\1_init.ts`, which the ESM loader rejects with `Only URLs with a scheme in: file, data, and node are supported`.

`fromFileSystem` now resolves the specifier through the `Path` service, so its type widens from `Loader<FileSystem>` to `Loader<FileSystem | Path>`. Callers that already provide an aggregate platform layer such as `NodeServices.layer` are unaffected; callers that provide `FileSystem` on its own now also need a `Path` layer, and on Windows it must be a platform-aware one rather than the POSIX `Path.layer`.
