---
"mock-llm": patch
---

`mock-llm/vitest`: the matcher types (`expect(mock).toHaveReceivedRequest(...)` and the rest) now work on **Vitest 4**.
They were only declared on Vitest 5's `Matchers<R, T>`. Vitest 4's `Matchers` has a different type-parameter list, so
that declaration didn't apply, and type-checked Vitest 4 projects reported every mock-llm matcher as missing. The
matchers worked at runtime. On Vitest 4, keep `skipLibCheck: true` (the usual default).
