/** Manual routes keep their device-local alias; primary and Connect hosts share a live name. */
export function environmentDisplayLabel(
  entry: { readonly target: { readonly _tag?: string; readonly label: string } },
  serverConfig: { readonly environment?: { readonly label: string } } | null,
): string {
  return entry.target._tag === "PrimaryConnectionTarget" ||
    entry.target._tag === "RelayConnectionTarget"
    ? (serverConfig?.environment?.label ?? entry.target.label)
    : entry.target.label;
}
