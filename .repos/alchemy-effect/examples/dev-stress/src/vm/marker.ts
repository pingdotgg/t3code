/**
 * Marker baked into the MicroVM image. Rewriting it forces the most
 * expensive rebuild in the stack, which the stress suite does exactly once —
 * every other phase asserts this image is NOT rebuilt.
 */
export const VM_MARKER = "vm-v1";
