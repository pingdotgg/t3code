import { createModelEvaluationAtoms } from "@t3tools/client-runtime/modelEvaluations";
import { connectionAtomRuntime } from "../connection/runtime";

export const modelEvaluations = createModelEvaluationAtoms(connectionAtomRuntime);
