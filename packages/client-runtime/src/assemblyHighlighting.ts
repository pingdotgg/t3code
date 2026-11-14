import { setCustomExtension } from "@pierre/diffs/utils/getFiletypeFromFileName";

// The default .s mapping is riscv, which the Highlights backend does not support.
for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
  setCustomExtension(extension, "asm");
}
