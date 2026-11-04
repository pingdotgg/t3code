// libuv sizes its fs pool on first use, so this stays the entry's first import. Each call on a
// folder that stops answering pins a thread; a larger pool keeps a few such folders from starving
// the server. WorkspaceIoGate reads this to leave half of the pool free.
process.env.UV_THREADPOOL_SIZE ??= "16";
