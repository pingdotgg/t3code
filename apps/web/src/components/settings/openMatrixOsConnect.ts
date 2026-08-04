import type { LocalApi } from "@t3tools/contracts";
import { MATRIX_OS_CONNECT_URL } from "@t3tools/shared/matrixOsConnect";

export async function openMatrixOsConnect(
  shell: Pick<LocalApi["shell"], "openExternal">,
): Promise<void> {
  await shell.openExternal(MATRIX_OS_CONNECT_URL);
}
