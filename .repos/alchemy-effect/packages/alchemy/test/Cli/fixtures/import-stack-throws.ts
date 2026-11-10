// Simulates a mid-edit save of a stack entrypoint: module evaluation throws
// (e.g. dereferencing an export that no longer exists), so `import()` of this
// file rejects. `alchemy dev` must survive this without exiting.
const missing = undefined as unknown as { key: string };

export default missing.key;
