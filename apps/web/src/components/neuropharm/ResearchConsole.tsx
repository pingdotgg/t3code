import type { NeuropharmAnalysisMode, NeuropharmAnalysisResult } from "@t3tools/contracts";
import { ActivityIcon, FileTextIcon, NetworkIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { ScientificGraphRenderer } from "./ScientificGraphRenderer";

const modes = [
  { value: "compound_profile", label: "Compound analysis" },
  { value: "receptor_explorer", label: "Receptor analysis" },
  { value: "stack_checker", label: "Interaction check" },
] satisfies ReadonlyArray<{ value: NeuropharmAnalysisMode; label: string }>;

export function ResearchConsole() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [mode, setMode] = useState<NeuropharmAnalysisMode>("compound_profile");
  const [query, setQuery] = useState("modafinil DAT cognition");
  const [powerUser, setPowerUser] = useState(true);
  const [result, setResult] = useState<NeuropharmAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const runAnalysis = async () => {
    setRunning(true);
    setError(null);
    try {
      const api = primaryEnvironmentId ? readEnvironmentApi(primaryEnvironmentId) : undefined;
      if (!api) {
        throw new Error("Neuropharm database not connected.");
      }
      const analysis = await api.neuropharm.analyze({
        mode,
        query,
        includeLatex: true,
        includeDiagrams: true,
        powerUser,
      });
      setResult(analysis);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Analysis failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-background/80 p-4 text-left">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select
          modal={false}
          value={mode}
          onValueChange={(value) => setMode(value as NeuropharmAnalysisMode)}
          items={modes}
        >
          <SelectTrigger className="w-48" aria-label="Analysis type">
            <ActivityIcon className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectGroup>
              <SelectGroupLabel>Analysis type</SelectGroupLabel>
              {modes.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectPopup>
        </Select>
        <div className="min-w-60 flex-1">
          <Input
            nativeInput
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            aria-label="Research query"
            placeholder="Enter compound name or receptor (e.g., modafinil, DAT, 5-HT2A)"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground" title="Enables extrapolation with confidence labels">
          <Switch checked={powerUser} onCheckedChange={setPowerUser} />
          Research mode
        </label>
        <Button type="button" onClick={runAnalysis} disabled={running || query.trim().length === 0}>
          {running ? "Analyzing pharmacology..." : "Analyze"}
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-amber-300/50 bg-amber-50/60 p-3 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
          <div className="min-w-0 space-y-3">
            <div>
              <div className="text-sm font-medium">{result.title}</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {result.estimate.summary}
              </p>
            </div>
            {result.graphSpecs.slice(0, 3).map((spec) => (
              <ScientificGraphRenderer key={`${spec.kind}:${spec.title}`} spec={spec} />
            ))}
          </div>
          <div className="space-y-3 text-xs">
            <div className="rounded-md border border-border/70 p-3">
              <div className="mb-2 flex items-center gap-1.5 font-medium">
                <NetworkIcon className="size-3.5 text-emerald-600" />
                Evidence sources
              </div>
              <div className="text-muted-foreground">
                {result.graphNodes.length} nodes, {result.graphEdges.length} edges,{" "}
                {result.estimate.evidence.length} evidence records.
              </div>
            </div>
            <div className="rounded-md border border-border/70 p-3">
              <div className="mb-2 flex items-center gap-1.5 font-medium">
                <ShieldAlertIcon className="size-3.5 text-amber-600" />
                Safety warnings
              </div>
              <ul className="space-y-1 text-muted-foreground">
                {result.safetyNotices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </div>
            {result.latex ? (
              <div className="rounded-md border border-border/70 p-3">
                <div className="mb-2 flex items-center gap-1.5 font-medium">
                  <FileTextIcon className="size-3.5 text-sky-600" />
                  Export preview
                </div>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {result.latex.latex}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
