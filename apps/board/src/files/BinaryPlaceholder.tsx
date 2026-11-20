import { FileQuestion } from "lucide-react";

export function BinaryPlaceholder({ name }: { name: string }) {
  return (
    <div
      data-testid="binary-placeholder"
      className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted"
    >
      <FileQuestion className="size-8" aria-hidden />
      <p className="text-fg">Binary file</p>
      <p className="text-[12px]">The viewer cannot show {name} as text.</p>
    </div>
  );
}
