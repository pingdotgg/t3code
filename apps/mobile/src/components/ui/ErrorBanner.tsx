import { Notice } from "./Notice";
import { defineNativePluginFeature } from "../../plugins/features";

export const ErrorBanner = defineNativePluginFeature(
  "native.components.ui.error-banner",
  BuiltinErrorBanner,
);

function BuiltinErrorBanner(props: { readonly message: string }) {
  return <Notice tone="danger" message={props.message} />;
}
