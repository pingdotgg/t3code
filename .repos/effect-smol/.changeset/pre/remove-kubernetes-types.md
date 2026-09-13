---
"effect": patch
---

Remove the `kubernetes-types` dependency by vendoring the Kubernetes Pod declarations used by the cluster helpers and exporting them from `effect/unstable/cluster/K8sTypes`.
