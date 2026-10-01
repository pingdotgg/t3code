import type { ComponentProps } from "react";
import type { ClientUiKit } from "../../dist/ui.js";

const active: ComponentProps<ClientUiKit["Icon"]> = { name: "annotate", active: true };
// @ts-expect-error Pack class strings are outside the frozen icon contract.
const styled: ComponentProps<ClientUiKit["Icon"]> = { name: "annotate", className: "text-primary" };
void active;
void styled;

const keepImporterOpen: ComponentProps<ClientUiKit["MenuRadioItem"]> = {
  value: "firefox",
  closeOnClick: false,
  children: "Firefox",
};
void keepImporterOpen;
