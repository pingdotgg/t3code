import { interpolate } from "remotion";
import type { CommentStep } from "../../shared/intro.ts";
import { mono, sans } from "../fonts.ts";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** GitHub's dark theme. */
const GH = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  fg: "#e6edf3",
  muted: "#8d96a0",
  link: "#4493f8",
  green: "#3fb950",
  greenBg: "#238636",
  yellow: "#d29922",
  red: "#f85149",
  bot: "#8957e5",
};

const BOX = { x: 300, y: 170, w: 1320, h: 850 };

const URL_RE = /(https?:\/\/\S+)/;
const Line = ({ text }: { text: string }) => (
  <div style={{ minHeight: 34 }}>
    {text.split(URL_RE).map((part, i) =>
      URL_RE.test(part) ? (
        <span key={i} style={{ color: GH.link, fontFamily: mono, fontSize: 26 }}>
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      ),
    )}
  </div>
);

/** A pull request page: title, checks, and the conversation. Only what's new animates in. */
export const PullRequestView = ({
  step,
  prev,
  local,
}: {
  step: CommentStep;
  prev?: CommentStep;
  local: number;
}) => {
  const samePr = prev?.pr.number === step.pr.number;
  const page = samePr ? 1 : interpolate(local, [0, 8], [0, 1], clamp);
  const oldComments = samePr ? prev!.comments.length : 0;
  const checkKey = (c: CommentStep["checks"][number]) => `${c.name}:${c.state}`;
  const oldChecks = new Set(samePr ? prev!.checks.map(checkKey) : []);
  const allPassed = step.checks.every((c) => c.state === "passed");
  const anyFailed = step.checks.some((c) => c.state === "failed");

  return (
    <div
      style={{
        position: "absolute",
        left: BOX.x,
        top: BOX.y,
        width: BOX.w,
        maxHeight: BOX.h,
        background: GH.bg,
        border: `2px solid ${GH.border}`,
        borderRadius: 14,
        padding: "36px 48px",
        boxSizing: "border-box",
        fontFamily: sans,
        color: GH.fg,
        opacity: page,
        transform: `translateY(${(1 - page) * 14}px)`,
        boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        overflow: "hidden",
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 600 }}>
        {step.pr.title} <span style={{ color: GH.muted, fontWeight: 400 }}>#{step.pr.number}</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginTop: 14,
          fontSize: 24,
          color: GH.muted,
        }}
      >
        <span
          style={{
            background: GH.greenBg,
            color: "white",
            borderRadius: 999,
            padding: "6px 18px",
            fontWeight: 600,
          }}
        >
          Open
        </span>
        <span>
          wants to merge into <code style={{ fontFamily: mono, color: GH.link }}>main</code> from{" "}
          <code style={{ fontFamily: mono, color: GH.link }}>{step.pr.branch}</code>
        </span>
      </div>
      <div style={{ height: 2, background: GH.border, margin: "28px 0" }} />

      {step.comments.map((comment, i) => {
        const q =
          i < oldComments
            ? 1
            : interpolate(
                local,
                [6 + (i - oldComments) * 6, 14 + (i - oldComments) * 6],
                [0, 1],
                clamp,
              );
        return (
          <div
            key={i}
            style={{
              display: "flex",
              gap: 20,
              marginBottom: 26,
              opacity: q,
              transform: `translateY(${(1 - q) * 18}px)`,
            }}
          >
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                flex: "none",
                background: comment.bot ? GH.bot : "#6e7681",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 30,
              }}
            >
              {comment.bot ? "⚗" : comment.author[0]!.toUpperCase()}
            </div>
            <div
              style={{
                flex: 1,
                border: `2px solid ${GH.border}`,
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  background: GH.panel,
                  padding: "12px 20px",
                  fontSize: 23,
                  color: GH.muted,
                  borderBottom: `2px solid ${GH.border}`,
                }}
              >
                <b style={{ color: GH.fg }}>{comment.author}</b>
                {comment.bot ? (
                  <span
                    style={{
                      marginLeft: 10,
                      border: `1.5px solid ${GH.border}`,
                      borderRadius: 999,
                      padding: "1px 10px",
                      fontSize: 18,
                    }}
                  >
                    bot
                  </span>
                ) : null}{" "}
                commented
              </div>
              <div style={{ padding: "18px 22px", fontSize: 28, lineHeight: 1.35 }}>
                {comment.lines.map((line, k) => (
                  <Line key={k} text={line} />
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {step.checks.length ? (
        <div
          style={{
            marginLeft: 76,
            border: `2px solid ${GH.border}`,
            borderRadius: 10,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "16px 22px",
              fontSize: 27,
              fontWeight: 600,
              background: GH.panel,
              borderBottom: `2px solid ${GH.border}`,
            }}
          >
            <span
              style={{
                color: anyFailed ? GH.red : allPassed ? GH.green : GH.yellow,
                marginRight: 12,
              }}
            >
              {anyFailed ? "✗" : allPassed ? "✓" : "●"}
            </span>
            {anyFailed
              ? "Some checks failed"
              : allPassed
                ? "All checks have passed"
                : "Some checks haven't completed yet"}
          </div>
          {step.checks.map((check) => {
            const q = oldChecks.has(checkKey(check))
              ? 1
              : interpolate(local, [4, 12], [0, 1], clamp);
            const color =
              check.state === "passed" ? GH.green : check.state === "failed" ? GH.red : GH.yellow;
            return (
              <div
                key={check.name}
                style={{
                  display: "flex",
                  gap: 14,
                  padding: "12px 22px",
                  fontSize: 24,
                  opacity: 0.4 + 0.6 * q,
                }}
              >
                <span style={{ color, width: 24 }}>
                  {check.state === "passed" ? "✓" : check.state === "failed" ? "✗" : "●"}
                </span>
                <span style={{ fontWeight: 600 }}>{check.name}</span>
                <span style={{ color: GH.muted }}>
                  {check.detail ?? (check.state === "pending" ? "In progress" : "")}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
