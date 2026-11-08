/**
 * Lane layout and per-row SVG for a `git log --topo-order` graph.
 * Derived from Visual Studio Code's `scmHistory.ts`
 * (Copyright (c) Microsoft Corporation, MIT License).
 *
 * Each row's output lanes become the next row's input lanes, so rows render as
 * independent SVGs that line up vertically.
 */

export interface GraphCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
}

export interface Swimlane {
  readonly id: string;
  readonly color: string;
}

export interface GraphRow {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly input: ReadonlyArray<Swimlane>;
  readonly output: ReadonlyArray<Swimlane>;
}

export const LANE_WIDTH = 11;
const BASE_ROW_HEIGHT = 22;
const CURVE_RADIUS = 5;
export const GRAPH_CIRCLE_RADIUS = 4;

const LANE_COLORS = ["#75BEFF", "#FFB000", "#DC267F", "#40B0A6", "#B66DFF", "#994F00"];

/** Assigns lanes for commits listed newest first in topological order. */
export function layoutGitGraph(commits: ReadonlyArray<GraphCommit>): GraphRow[] {
  const rows: GraphRow[] = [];
  let colorIndex = -1;
  const nextColor = () => {
    colorIndex = (colorIndex + 1) % LANE_COLORS.length;
    return LANE_COLORS[colorIndex]!;
  };
  let lanes: ReadonlyArray<Swimlane> = [];

  for (const commit of commits) {
    const input = lanes;
    const output: Swimlane[] = [];
    let firstParentPlaced = false;

    for (const lane of input) {
      if (lane.id !== commit.sha) {
        output.push(lane);
      } else if (!firstParentPlaced && commit.parents.length > 0) {
        output.push({ id: commit.parents[0]!, color: lane.color });
        firstParentPlaced = true;
      }
    }
    for (let i = firstParentPlaced ? 1 : 0; i < commit.parents.length; i += 1) {
      output.push({ id: commit.parents[i]!, color: nextColor() });
    }

    rows.push({ sha: commit.sha, parents: commit.parents, input, output });
    lanes = output;
  }
  return rows;
}

export interface RowGraph {
  readonly width: number;
  readonly paths: ReadonlyArray<{ readonly d: string; readonly color: string }>;
  readonly circle: { readonly cx: number; readonly cy: number; readonly color: string };
}

/** Taller rows stretch the lanes vertically while keeping curves and circles fixed. */
export function rowGraph(row: GraphRow, height: number): RowGraph {
  const { input, output, parents, sha } = row;
  const centerY = height / 2;
  const padding = (height - BASE_ROW_HEIGHT) / 2;
  const inputIndex = input.findIndex((lane) => lane.id === sha);
  const circleIndex = inputIndex === -1 ? input.length : inputIndex;
  const circleColor = output[circleIndex]?.color ?? input[circleIndex]?.color ?? LANE_COLORS[0]!;
  const x = (index: number) => LANE_WIDTH * (index + 1);
  const paths: { d: string; color: string }[] = [];

  let outputIndex = 0;
  for (let index = 0; index < input.length; index += 1) {
    const lane = input[index]!;
    if (lane.id === sha) {
      if (index === circleIndex) {
        outputIndex += 1;
      } else {
        // A second lane converging on this commit curves into its circle.
        paths.push({
          d: [
            `M ${x(index)} 0`,
            ...(padding > 0 ? [`V ${padding}`] : []),
            `A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * index} ${centerY}`,
            `H ${x(circleIndex)}`,
          ].join(" "),
          color: lane.color,
        });
      }
    } else if (outputIndex < output.length && lane.id === output[outputIndex]!.id) {
      paths.push({
        d:
          index === outputIndex
            ? `M ${x(index)} 0 V ${height}`
            : [
                `M ${x(index)} 0`,
                `V ${centerY - CURVE_RADIUS}`,
                `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 1 ${x(index) - CURVE_RADIUS} ${centerY}`,
                `H ${x(outputIndex) + CURVE_RADIUS}`,
                `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 0 ${x(outputIndex)} ${centerY + CURVE_RADIUS}`,
                `V ${height}`,
              ].join(" "),
        color: lane.color,
      });
      outputIndex += 1;
    }
  }

  for (let i = 1; i < parents.length; i += 1) {
    let parentIndex = -1;
    for (let j = output.length - 1; j >= 0; j -= 1) {
      if (output[j]!.id === parents[i]) {
        parentIndex = j;
        break;
      }
    }
    if (parentIndex === -1) continue;
    paths.push({
      d: [
        `M ${LANE_WIDTH * parentIndex} ${centerY}`,
        `A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${x(parentIndex)} ${centerY + LANE_WIDTH}`,
        ...(padding > 0 ? [`V ${height}`] : []),
        `M ${LANE_WIDTH * parentIndex} ${centerY}`,
        `H ${x(circleIndex)}`,
      ].join(" "),
      color: output[parentIndex]!.color,
    });
  }

  if (inputIndex !== -1) {
    paths.push({ d: `M ${x(circleIndex)} 0 V ${centerY}`, color: input[inputIndex]!.color });
  }
  if (parents.length > 0) {
    paths.push({ d: `M ${x(circleIndex)} ${centerY} V ${height}`, color: circleColor });
  }

  return {
    width: LANE_WIDTH * (Math.max(input.length, output.length, 1) + 1),
    paths,
    circle: { cx: x(circleIndex), cy: centerY, color: circleColor },
  };
}
