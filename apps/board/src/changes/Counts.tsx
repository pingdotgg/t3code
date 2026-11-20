export function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex shrink-0 gap-1.5 font-mono text-[11px] tabular-nums">
      {additions > 0 && <span className="text-emerald-300">+{additions}</span>}
      {deletions > 0 && <span className="text-red-300">−{deletions}</span>}
    </span>
  );
}
