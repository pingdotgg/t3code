import type { HostStorageResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

function formatStorageBytes(bytes: number): string {
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 5);
  const value = (bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${value} ${BYTE_UNITS[unit]}`;
}

/** A refreshing or failed reading must not present cached capacity as current. */
export function getHostStoragePresentation(
  result: AsyncResult.AsyncResult<HostStorageResult, unknown>,
) {
  if (AsyncResult.isInitial(result) || result.waiting) {
    return { status: "loading" } as const;
  }
  if (!AsyncResult.isSuccess(result) || result.value.storage == null) {
    return { status: "unavailable" } as const;
  }
  const { totalBytes, availableBytes } = result.value.storage;
  return {
    status: "available",
    label: `${formatStorageBytes(availableBytes)} available of ${formatStorageBytes(totalBytes)}`,
    availablePercent: (availableBytes / totalBytes) * 100,
    sampledAt: result.value.sampledAt,
  } as const;
}
