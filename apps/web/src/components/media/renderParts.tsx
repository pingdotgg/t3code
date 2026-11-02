import { Fragment, type ReactNode } from "react";

/**
 * Fills `{name}` placeholders of an already translated template with React nodes, so a
 * sentence can carry bold or linked fragments without being cut into translated pieces.
 * Pass the placeholder back to `t` (`t(key, { name: "{name}" })`) to keep it in the template.
 */
export function renderParts(template: string, parts: Record<string, ReactNode>): ReactNode {
  let position = 0;
  return template.split(/(\{\w+\})/g).map((segment) => {
    const name = /^\{(\w+)\}$/.exec(segment)?.[1];
    return (
      <Fragment key={position++}>
        {name !== undefined && Object.hasOwn(parts, name) ? parts[name] : segment}
      </Fragment>
    );
  });
}
