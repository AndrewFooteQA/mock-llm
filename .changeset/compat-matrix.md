---
"mock-llm": minor
---

Supported versions are now tested, not assumed. A compatibility matrix runs each provider SDK, test framework and
TypeScript at its oldest supported and latest release, and the README's new **Compatibility** table is generated from its
results.

**Breaking: the optional peer dependency ranges are narrowed to what is tested.**

- `vitest`: `>=4.0.1` (was `>=1`)
- `@playwright/test`: `>=1.56` (was `>=1.40`)

`@jest/globals` (`>=29`) and `yaml` (`>=2`) are unchanged. To migrate, upgrade Vitest or Playwright if you're below these.
Older versions were never tested, and npm now warns about them.

Supported provider SDK floors (compatibility claims, not peer dependencies):

- `openai` ≥ 6.0.0
- `@anthropic-ai/sdk` ≥ 0.66.0
- `@google/genai` ≥ 1.6.0
- `@aws-sdk/client-bedrock-runtime` ≥ 3.906.0

Published types are checked with TypeScript ≥ 6.0.2.
