import { useGT } from "gt-react";

import { InlineButton } from "../ui/button";

export function HiddenTestFilesCount({ count }: { count: number }) {
  const gt = useGT();
  return gt("{count, plural, one {{count} test file hidden} other {{count} test files hidden}}", {
    count,
  });
}

export function HiddenTestFilesEmptyState({
  count,
  onShow,
}: {
  count: number;
  onShow: () => void;
}) {
  const gt = useGT();
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
      <p>
        <HiddenTestFilesCount count={count} />
      </p>
      <InlineButton onClick={onShow}>{gt("Show test files")}</InlineButton>
    </div>
  );
}
