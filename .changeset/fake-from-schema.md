---
"mock-llm": patch
---

`fakeFromSchema(schema, { seed, violate })` is now usable from the package. It used to require an `Rng` instance as its
second argument, but `Rng` isn't exported, so outside the library it could only be called with a hand-made object. The
`Rng` form still works. The function is now documented next to `replyFromSchema`.
