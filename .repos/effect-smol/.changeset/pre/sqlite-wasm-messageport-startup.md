---
"@effect/sql-sqlite-wasm": patch
---

Start incoming MessagePort queues after registering the SQLite WASM client and OPFS worker listeners. Fresh ports, including a SharedWorker's client port, no longer require manual activation to receive ready messages and query replies or process worker requests.
