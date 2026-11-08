import type { ReactNode } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";

export function LinearSelect({
  label,
  value,
  onChange,
  options,
  empty = "All",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ id: string; name: string }>;
  empty?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-32 flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Select value={value} onValueChange={(next) => onChange(next ?? "")} disabled={disabled}>
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{options.find((option) => option.id === value)?.name ?? empty}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="">{empty}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}
export function LinearMessage({ children, retry }: { children: ReactNode; retry?: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 p-10 text-center text-sm text-muted-foreground"
    >
      {children}
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function LinearMarkdown({ text }: { text: string | null }) {
  return text ? (
    <ChatMarkdown text={text} cwd={undefined} parseRawHtml={false} />
  ) : (
    <p className="text-sm text-muted-foreground">No description.</p>
  );
}
export function LinearPager({
  hasNextPage,
  after,
  onNext,
  onPrevious,
  pending,
}: {
  hasNextPage: boolean;
  after: string | undefined;
  onNext: () => void;
  onPrevious: () => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
      <Button size="sm" variant="ghost" disabled={!after || pending} onClick={onPrevious}>
        Previous
      </Button>
      <Button size="sm" variant="outline" disabled={!hasNextPage || pending} onClick={onNext}>
        Next page
      </Button>
    </div>
  );
}
