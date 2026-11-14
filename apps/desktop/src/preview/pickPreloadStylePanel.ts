import {
  createButton,
  createField,
  createStyleSection,
  createUnitControl,
  createUnitInput,
  PRIMARY,
  styleControl,
  type SelectedElement,
} from "./pickPreloadUi.ts";

export interface AnnotationStylePanelInput {
  readonly stylePanel: HTMLElement;
  readonly selected: ReadonlyMap<Element, SelectedElement>;
  readonly setStyleForSelected: (property: string, value: string) => void;
}

/** Builds the annotation editor's style sections and its sync routine. */
export function createAnnotationStylePanel(input: AnnotationStylePanelInput): {
  readonly syncStyleControls: () => void;
} {
  const { stylePanel, selected, setStyleForSelected } = input;

const textSection = createStyleSection();
const colorsSection = createStyleSection();
const bordersSection = createStyleSection();
const sizingSection = createStyleSection();
stylePanel.append(textSection, colorsSection, bordersSection, sizingSection);

const fontFamily = document.createElement("select");
for (const value of ["inherit", "system-ui", "sans-serif", "serif", "monospace"]) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = value;
  fontFamily.appendChild(option);
}
fontFamily.addEventListener("change", () => setStyleForSelected("font-family", fontFamily.value));
textSection.appendChild(createField("Font", fontFamily));

const fontSize = createUnitInput("px", "16");
fontSize.min = "1";
fontSize.max = "300";
fontSize.addEventListener("input", () => {
  if (fontSize.value) setStyleForSelected("font-size", `${fontSize.value}px`);
});
textSection.appendChild(createField("Font size", fontSize));

const fontWeight = document.createElement("select");
for (const value of ["300", "400", "500", "600", "700", "800", "900"]) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = value;
  fontWeight.appendChild(option);
}
fontWeight.addEventListener("change", () => setStyleForSelected("font-weight", fontWeight.value));
textSection.appendChild(createField("Font weight", fontWeight));

const lineHeight = document.createElement("input");
lineHeight.type = "text";
lineHeight.placeholder = "normal / 1.4";
lineHeight.addEventListener("change", () => {
  if (lineHeight.value.trim()) setStyleForSelected("line-height", lineHeight.value.trim());
});
textSection.appendChild(createField("Line height", lineHeight));

const createColorRow = (
  labelText: string,
  property: string,
  section: HTMLElement,
): { row: HTMLLabelElement; color: HTMLInputElement; text: HTMLInputElement } => {
  const row = document.createElement("label");
  row.className =
    "grid min-h-7 grid-cols-[82px_minmax(0,1fr)] items-center gap-2 font-sans text-xs font-medium text-muted-foreground";
  const label = document.createElement("span");
  label.textContent = labelText;
  const control = document.createElement("div");
  control.className =
    "grid h-7 grid-cols-[22px_minmax(0,1fr)] items-center gap-1 rounded-md border border-input bg-background px-1 shadow-xs";
  const color = document.createElement("input");
  color.type = "color";
  color.setAttribute("aria-label", labelText);
  color.style.cssText =
    "width:20px;height:20px;padding:0;border:0;border-radius:5px;overflow:hidden;background:transparent;cursor:pointer";
  const text = document.createElement("input");
  text.type = "text";
  text.setAttribute("aria-label", `${labelText} value`);
  text.className =
    "min-w-0 w-full border-0 bg-transparent font-mono text-xs text-foreground outline-none";
  color.addEventListener("input", () => {
    text.value = color.value;
    setStyleForSelected(property, color.value);
  });
  text.addEventListener("change", () => {
    const value = text.value.trim();
    if (!value) return;
    setStyleForSelected(property, value);
    if (/^#[0-9a-f]{6}$/i.test(value)) color.value = value;
  });
  control.append(color, text);
  row.append(label, control);
  section.appendChild(row);
  return { row, color, text };
};

const textColor = createColorRow("Text color", "color", colorsSection);
const backgroundColor = createColorRow("Background", "background-color", colorsSection);

const opacity = document.createElement("input");
opacity.type = "range";
opacity.min = "0";
opacity.max = "1";
opacity.step = "0.05";
opacity.value = "1";
opacity.style.accentColor = PRIMARY;
opacity.addEventListener("input", () => setStyleForSelected("opacity", opacity.value));
colorsSection.appendChild(createField("Opacity", opacity));

const radius = createUnitInput("px", "0");
radius.min = "0";
radius.max = "300";
radius.addEventListener("input", () => {
  if (radius.value) setStyleForSelected("border-radius", `${radius.value}px`);
});
bordersSection.appendChild(createField("Radius", radius));

const borderColor = createColorRow("Border color", "border-color", bordersSection);

const borderWidth = createUnitInput("px", "0");
borderWidth.min = "0";
borderWidth.max = "100";
borderWidth.addEventListener("input", () => {
  if (borderWidth.value) {
    setStyleForSelected("border-style", "solid");
    setStyleForSelected("border-width", `${borderWidth.value}px`);
  }
});
bordersSection.appendChild(createField("Border width", borderWidth));

const dimensions = document.createElement("div");
dimensions.style.cssText =
  "display:grid;grid-template-columns:82px minmax(0,1fr);gap:8px;align-items:center";
const dimensionLabel = document.createElement("div");
dimensionLabel.className = "grid gap-2 font-sans text-xs font-medium text-muted-foreground";
dimensionLabel.innerHTML = "<span>Width</span><span>Height</span>";
const dimensionControls = document.createElement("div");
dimensionControls.style.cssText = "position:relative;display:grid;gap:3px;padding-left:22px";
const widthInput = createUnitInput("px", "auto");
const heightInput = createUnitInput("px", "auto");
styleControl(widthInput);
styleControl(heightInput);
const aspectLock = createButton("", "Lock aspect ratio");
aspectLock.setAttribute("aria-pressed", "true");
aspectLock.style.cssText +=
  ";position:absolute;left:0;top:50%;transform:translateY(-50%);width:18px;height:38px;padding:0";
aspectLock.className += " bg-primary/10 text-primary";
dimensionControls.append(
  createUnitControl(widthInput),
  createUnitControl(heightInput),
  aspectLock,
);
dimensions.append(dimensionLabel, dimensionControls);
sizingSection.appendChild(dimensions);

let aspectLocked = true;
let aspectRatio = 1;
const refreshAspectButton = (): void => {
  aspectLock.innerHTML = aspectLocked
    ? '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M8 6.5 9.5 5A3.5 3.5 0 0 1 14.5 10l-1.5 1.5M12 13.5 10.5 15A3.5 3.5 0 0 1 5.5 10L7 8.5M7.5 12.5l5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="m6 6 8 8M8 6.5 9.5 5A3.5 3.5 0 0 1 14 9M12 13.5 10.5 15A3.5 3.5 0 0 1 6 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  aspectLock.setAttribute("aria-pressed", String(aspectLocked));
  aspectLock.classList.toggle("bg-primary/10", aspectLocked);
  aspectLock.classList.toggle("text-primary", aspectLocked);
  aspectLock.classList.toggle("bg-muted", !aspectLocked);
  aspectLock.classList.toggle("text-muted-foreground", !aspectLocked);
};
aspectLock.addEventListener("click", () => {
  aspectLocked = !aspectLocked;
  refreshAspectButton();
});
widthInput.addEventListener("input", () => {
  const width = Number(widthInput.value);
  if (!Number.isFinite(width) || width <= 0) return;
  setStyleForSelected("width", `${width}px`);
  if (aspectLocked && aspectRatio > 0) {
    const height = Math.max(1, Math.round(width / aspectRatio));
    heightInput.value = String(height);
    setStyleForSelected("height", `${height}px`);
  }
});
heightInput.addEventListener("input", () => {
  const height = Number(heightInput.value);
  if (!Number.isFinite(height) || height <= 0) return;
  setStyleForSelected("height", `${height}px`);
  if (aspectLocked && aspectRatio > 0) {
    const width = Math.max(1, Math.round(height * aspectRatio));
    widthInput.value = String(width);
    setStyleForSelected("width", `${width}px`);
  }
});
refreshAspectButton();

const addSpacingField = (
  label: string,
  property: string,
  placeholder: string,
): HTMLInputElement => {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.addEventListener("change", () => {
    if (input.value.trim()) setStyleForSelected(property, input.value.trim());
  });
  sizingSection.appendChild(createField(label, input));
  return input;
};
const padding = addSpacingField("Padding", "padding", "0 0 0 0");
const margin = addSpacingField("Margin", "margin", "0 0 0 0");
const gap = addSpacingField("Gap", "gap", "0px");

const syncStyleControls = (): void => {
  const first = selected.values().next().value as SelectedElement | undefined;
  if (!first) return;
  const computed = getComputedStyle(first.element);
  const rect = first.element.getBoundingClientRect();
  aspectRatio = rect.height > 0 ? rect.width / rect.height : 1;
  widthInput.value = String(Math.round(rect.width));
  heightInput.value = String(Math.round(rect.height));
  fontSize.value = String(Math.round(Number.parseFloat(computed.fontSize) || 16));
  fontWeight.value = computed.fontWeight.match(/^[0-9]+$/) ? computed.fontWeight : "400";
  lineHeight.value = computed.lineHeight;
  fontFamily.value = Array.from(fontFamily.options).some(
    (option) => option.value === computed.fontFamily,
  )
    ? computed.fontFamily
    : "inherit";
  textColor.text.value = computed.color;
  backgroundColor.text.value = computed.backgroundColor;
  borderColor.text.value = computed.borderColor;
  opacity.value = computed.opacity;
  radius.value = String(Math.round(Number.parseFloat(computed.borderRadius) || 0));
  borderWidth.value = String(Math.round(Number.parseFloat(computed.borderWidth) || 0));
  padding.value = computed.padding;
  margin.value = computed.margin;
  gap.value = computed.gap === "normal" ? "0px" : computed.gap;
};

  return { syncStyleControls };
}
