/** Whether a clipboard payload contains text that the editor should paste. */
export function clipboardHasText(clipboardData: Pick<DataTransfer, "getData" | "types">): boolean {
  return (
    clipboardData.getData("text/plain").length > 0 ||
    Array.from(clipboardData.types).includes("text/html")
  );
}
