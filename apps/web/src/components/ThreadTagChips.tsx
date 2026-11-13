import { Badge } from "./ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const MAX_CHIPS = 2;

/** Like PR labels: each chip truncates on its own, and "+N" names the rest on hover. */
export function ThreadTagChips(props: { readonly tags: ReadonlyArray<string> | undefined }) {
  if (props.tags === undefined || props.tags.length === 0) return null;
  const shown = props.tags.slice(0, MAX_CHIPS);
  const hidden = props.tags.slice(MAX_CHIPS);
  return (
    <span className="flex min-w-0 shrink items-center gap-1">
      {shown.map((tag) => (
        <Badge
          key={tag}
          variant="outline"
          size="sm"
          title={tag}
          className="min-w-0 max-w-24 shrink justify-start"
        >
          <span className="truncate">{tag}</span>
        </Badge>
      ))}
      {hidden.length > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={<Badge variant="outline" size="sm" className="shrink-0" />}
            aria-label={`${hidden.length} more ${hidden.length === 1 ? "tag" : "tags"}: ${hidden.join(", ")}`}
          >
            +{hidden.length}
          </TooltipTrigger>
          <TooltipPopup side="top">{hidden.join(", ")}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
