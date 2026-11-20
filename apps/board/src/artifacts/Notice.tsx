export function Notice({
  children,
  tone = "text-muted",
}: {
  children: string;
  tone?: "text-muted" | "text-red-300";
}) {
  return (
    <p role="status" className={`px-4 py-3 text-[12px] ${tone}`}>
      {children}
    </p>
  );
}
