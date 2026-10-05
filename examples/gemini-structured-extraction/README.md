# Example: Gemini structured extraction (Vitest)

Invoice extraction with `@google/genai` and a JSON schema (`responseJsonSchema`), tested with mock-llm. It shows how to:

- generate schema-valid responses from the request's own schema (`replyFromSchema()`)
- test validation with **schema violations** (`replyFromSchema({ violate: true })`), **code-fenced JSON**, **almost-JSON**, **truncation** and **safety blocks**
- script a *sequence* (bad output, then good) to test a repair-and-retry loop
- assert the schema was sent and the retry prompt explained the error (`toHaveReceivedRequest`, `toHaveReceivedPrompt`)
- **stream** a long extraction with `generateContentStream` (exact chunks), and report a **mid-stream error**
  (`faults.streamError`) instead of returning half an invoice
- run the same extraction through a **Vertex AI** client (a static OAuth token instead of an API key)
- unit-test the validator with fixtures from `fakeFromSchema(INVOICE_SCHEMA, { seed, violate })`

```sh
npm install
npm test        # tsc --noEmit (strict, against mock-llm's published types), then vitest
```

| File | What it is |
|---|---|
| `src/extract.ts` | Extraction, lenient parsing, validation and retry. Nothing mock-specific. |
| `test/extract.test.ts` | Tests |
