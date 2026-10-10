import { Toast } from "@base-ui/react/toast";
import type { ThreadToastData } from "./toast";

export const toastManager = Toast.createToastManager<ThreadToastData>();
export const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
