/**
 * The first thing to say about a report, offered as buttons so an empty
 * conversation is one click from useful. Clicking one sends it.
 */
import { Button } from "../ui/button";

const STARTERS = ["Fix this", "Look into this", "Explain the evidence"] as const;

export function ReportStarters({ onStart }: { readonly onStart: (text: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 pb-1.5">
      {STARTERS.map((starter) => (
        <Button key={starter} size="xs" variant="outline" onClick={() => onStart(starter)}>
          {starter}
        </Button>
      ))}
    </div>
  );
}
