import { Img, interpolate, staticFile } from "remotion";
import type { BrowserStep, IntroStep, TerminalStep } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";
import { brand } from "../theme.ts";

/** The same area code slides use, so a cut between code and a pane doesn't jump. */
const AREA = { x: 110, y: 150, width: 1700, height: 880 };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const TrafficLights = () => (
  <div style={{ display: "flex", gap: 9 }}>
    {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
      <div key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c }} />
    ))}
  </div>
);

const Window = ({ children, header }: { children: React.ReactNode; header: React.ReactNode }) => (
  <div
    style={{
      position: "absolute",
      left: AREA.x,
      top: AREA.y,
      width: AREA.width,
      height: AREA.height,
      borderRadius: 14,
      overflow: "hidden",
      background: "#1a1814",
      border: "1px solid #2e2a23",
      boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
      display: "flex",
      flexDirection: "column",
    }}
  >
    <div
      style={{
        height: 52,
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 22,
        padding: "0 20px",
        background: "#221f1a",
        borderBottom: "1px solid #2e2a23",
      }}
    >
      <TrafficLights />
      {header}
    </div>
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
  </div>
);

/**
 * A terminal: one command's output so far. Lines carried over from the previous
 * step stay put; only the new ones fade in, top to bottom.
 */
export const TerminalPane = ({
  step,
  prev,
  local,
}: {
  step: TerminalStep;
  prev?: IntroStep;
  local: number;
}) => {
  const same = prev?.kind === "terminal" && prev.group === step.group;
  const firstNew = step.lines.length - step.fresh;
  // 26px fits about 20 lines in the pane; longer output shrinks to fit.
  const rows =
    step.lines.length + (step.progress ? step.progress.rows.length + step.progress.done.length : 0);
  const size = Math.min(26, Math.floor(850 / (rows * 1.5 + 2)));
  return (
    <Window
      header={
        <div style={{ display: "flex", gap: 6, fontFamily: sans, fontSize: 18 }}>
          {(step.tabs ?? ["terminal"]).map((tab, i) => (
            <div
              key={tab}
              style={{
                padding: "6px 16px",
                borderRadius: 8,
                color: i === (step.active ?? 0) ? brand.fg : brand.fgMuted,
                background: i === (step.active ?? 0) ? "#2e2a23" : "transparent",
              }}
            >
              {tab}
            </div>
          ))}
        </div>
      }
    >
      <div
        style={{
          padding: "26px 32px",
          fontFamily: mono,
          fontSize: size,
          lineHeight: 1.5,
          whiteSpace: "pre",
        }}
      >
        {step.lines.map((line, i) => {
          const isNew = i >= firstNew || !same;
          const at = (i - firstNew) * 2;
          const opacity = isNew ? interpolate(local, [at, at + 4], [0, 1], clamp) : 1;
          return (
            <div key={i} style={{ opacity, minHeight: size * 1.5 }}>
              {line.map((t, k) => (
                <span key={k} style={{ color: t.color, fontWeight: t.bold ? 700 : undefined }}>
                  {t.text}
                </span>
              ))}
            </div>
          );
        })}
        {step.progress ? (
          <DeployProgress progress={step.progress} local={local} size={size} />
        ) : null}
      </div>
    </Window>
  );
};

const SPINNER = ["◐", "◓", "◑", "◒"];

/** Rows of a live deploy: pending, then a spinner while in progress, then a check. */
const DeployProgress = ({
  progress,
  local,
  size,
}: {
  progress: NonNullable<TerminalStep["progress"]>;
  local: number;
  size: number;
}) => {
  // Resource rows: name, then (type). Binding rows are longer and span both columns.
  const nameW = Math.max(...progress.rows.filter((r) => !r.binding).map((r) => r.name.length)) + 2;
  const typeW = Math.max(...progress.rows.map((r) => (r.type ? r.type.length + 2 : 0))) + 2;
  const totalW = Math.max(
    nameW + typeW,
    ...progress.rows.filter((r) => r.binding).map((r) => r.name.length + 4),
  );
  return (
    <>
      {progress.rows.map((row) => {
        const state = local < row.from ? "pending" : local < row.to ? "working" : "done";
        const color = row.binding ? "#6cb6ff" : "#8ddb8c";
        const label =
          state === "pending"
            ? "pending"
            : state === "working"
              ? `${SPINNER[Math.floor(local / 3) % 4]} ${row.binding ? "attaching" : "creating"}`
              : `✓ ${row.binding ? "attached" : "created"}`;
        const name = row.binding ? `  ${row.name}`.padEnd(totalW) : row.name.padEnd(nameW);
        const type = row.binding ? "" : (row.type ? `(${row.type})` : "").padEnd(totalW - nameW);
        return (
          <div key={row.name} style={{ minHeight: size * 1.5 }}>
            <span
              style={{
                color: state === "pending" ? brand.fgMuted : brand.fg,
                fontWeight: row.binding ? undefined : 700,
              }}
            >
              {name}
            </span>
            <span style={{ color: brand.fgMuted }}>{type}</span>
            <span style={{ color: state === "pending" ? brand.fgMuted : color }}>{label}</span>
          </div>
        );
      })}
      {progress.done.map((line, i) => (
        <div
          key={`done-${i}`}
          style={{
            opacity: interpolate(
              local,
              [progress.at + i * 2, progress.at + i * 2 + 5],
              [0, 1],
              clamp,
            ),
            minHeight: size * 1.5,
          }}
        >
          {line.map((t, k) => (
            <span key={k} style={{ color: t.color, fontWeight: t.bold ? 700 : undefined }}>
              {t.text}
            </span>
          ))}
        </div>
      ))}
    </>
  );
};

/** A browser window showing one screenshot. A new screenshot cross-fades in. */
export const BrowserPane = ({
  step,
  prev,
  local,
}: {
  step: BrowserStep;
  prev?: IntroStep;
  local: number;
}) => {
  const before = prev?.kind === "browser" && prev.image !== step.image ? prev.image : undefined;
  const p = interpolate(local, [0, 8], [0, 1], clamp);
  return (
    <Window
      header={
        <div
          style={{
            flex: 1,
            maxWidth: 900,
            margin: "0 auto",
            padding: "7px 18px",
            borderRadius: 8,
            background: "#15130f",
            fontFamily: sans,
            fontSize: 18,
            color: brand.fgMuted,
          }}
        >
          {step.url}
        </div>
      }
    >
      {before ? (
        <Img
          src={staticFile(`intro/assets/${before}`)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "top",
          }}
        />
      ) : null}
      <Img
        src={staticFile(`intro/assets/${step.image}`)}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "top",
          opacity: prev?.kind === "browser" && !before ? 1 : p,
        }}
      />
    </Window>
  );
};
