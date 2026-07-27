---
"effect": patch
---

Make `Schema.Date` reject invalid dates and remove the redundant `Schema.DateValid`, `Schema.isDateValid`, and `Schema.isDateValidReviver` APIs.

`Schema.DateFromString` and `Schema.DateFromMillis` now fail decoding when their input would produce an invalid date.

Remove `Schema.Annotations.ToArbitrary.GenerationConstraint.valid`; `Schema.Date` arbitraries now generate only valid dates by default.
