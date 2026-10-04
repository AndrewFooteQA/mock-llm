# Example: Gemini structured extraction (Vitest)

Invoice extraction with `@google/genai` and a JSON schema (`responseJsonSchema`), tested with mock-llm. It shows how to:

- generate schema-valid responses from the request's own schema (`replyFromSchema()`)
- test validation with **schema violations** (`replyFromSchema({ violate: true })`), **code-fenced JSON**, **almost-JSON**, **truncation** and **safety blocks**
- script a *sequence* (bad output, then good) to test a repair-and-retry loop
- assert the schema was sent and the retry prompt explained the error (`toHaveReceivedRequest`, `toHaveReceivedPrompt`)

```sh
npm install
npm test
```

| File | What it is |
|---|---|
| `src/extract.ts` | Extraction, lenient parsing, validation and retry. Nothing mock-specific. |
| `test/extract.test.ts` | Tests |
