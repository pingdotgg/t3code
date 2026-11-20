import type { ReactNode } from "react";

/** Where a project's value comes from, with the way back to the environment's. */
export interface Origin {
  readonly inherited: boolean;
  readonly onReset: () => void;
}

export function SettingsRow({
  title,
  description,
  origin,
  control,
  children,
}: {
  title: string;
  description?: ReactNode;
  origin?: Origin | undefined;
  control?: ReactNode;
  /** Full-width content under the title, such as a script editor. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-fg">{title}</span>
            {origin &&
              (origin.inherited ? (
                <span className="text-xs text-faint">Inherited</span>
              ) : (
                <>
                  <span className="text-xs text-sky-400">Overridden</span>
                  <button
                    type="button"
                    aria-label={`Reset ${title} to inherited`}
                    onClick={origin.onReset}
                    className="rounded-sm text-xs text-muted underline hover:text-fg"
                  >
                    Reset
                  </button>
                </>
              ))}
          </div>
          {description && <p className="mt-0.5 text-xs text-faint">{description}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children}
    </div>
  );
}
