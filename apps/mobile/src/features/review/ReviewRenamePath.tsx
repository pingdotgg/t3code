import { reviewRenameSegments } from "@t3tools/client-runtime/review-workspace";
import { AppText as Text } from "../../components/ui/AppText";

/** Keep a rename on one line, highlighting changed characters rather than entire paths. */
export function ReviewRenamePath({
  path,
  previousPath,
  directory = true,
}: {
  path: string;
  previousPath: string;
  directory?: boolean;
}) {
  const segments = reviewRenameSegments(previousPath, path, directory);
  return (
    <Text numberOfLines={1} ellipsizeMode="tail" className="min-w-0 flex-1 text-sm">
      {segments.map((part, index) => {
        const offset = segments
          .slice(0, index)
          .reduce((length, segment) => length + segment.text.length, 0);
        const key = `${part.kind}:${offset}:${part.text}`;
        return (
          <Text
            key={key}
            className={
              part.kind === "removed"
                ? "bg-red-500/10"
                : part.kind === "added"
                  ? "bg-green-500/10"
                  : part.kind === "context"
                    ? "text-foreground-muted"
                    : undefined
            }
          >
            {part.text}
          </Text>
        );
      })}
    </Text>
  );
}
