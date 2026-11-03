export * from "./_generated/schema.gen.ts";
export * from "./_generated/meta.gen.ts";
export * from "./_generated/namespaces.gen.ts";

// Mirrors codex_protocol::protocol::MAX_THREAD_GOAL_OBJECTIVE_CHARS, which the
// generated schema does not carry. Codex counts Unicode scalar values (Rust
// `chars()`), not UTF-16 code units.
export const MAX_THREAD_GOAL_OBJECTIVE_CHARS = 4_000;
