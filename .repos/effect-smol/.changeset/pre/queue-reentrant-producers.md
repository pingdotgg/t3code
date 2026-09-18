---
"effect": patch
---

Fix `Queue` message duplication, capacity overruns, and consumer defects when a resumed producer synchronously uses the same queue. Zero-capacity queues now reserve each handed-off message for its consumer before resuming the producer.
