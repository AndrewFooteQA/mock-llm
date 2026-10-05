# Example: RAG knowledge base (embeddings, token counting, models, cost)

A small retrieval-augmented FAQ assistant, tested with mock-llm. Questions are embedded and matched against the FAQ by
cosine similarity, and the best answers go into Claude's prompt. Before sending, the app counts the prompt's tokens with
the provider and drops the lowest-ranked passages until the prompt fits a budget. It picks its chat model from
`models.list`.

It covers the **non-chat endpoints** through each official SDK:

| What | Provider · SDK call |
|---|---|
| Embeddings | OpenAI `embeddings.create` (SDK default base64 **and** `encoding_format: 'float'`) · Gemini AI Studio `embedContent` (batch) · Gemini **Vertex AI** (`text-embedding-005` → `:predict`, OAuth token) · Bedrock Titan v2 via `InvokeModel` |
| Token counting | Anthropic `messages.countTokens` · Gemini `models.countTokens` · Bedrock `CountTokens` |
| Model listing | Anthropic `models.list` |
| Assertions | `toHaveReceivedPrompt` (top passage reached the prompt), `toHaveReceivedRequest({ endpoint })`, `toCostLessThan` + `journal.cost()` with a custom `pricing` entry, **strict mode** |

```sh
npm install
npm test        # tsc --noEmit (strict), then vitest
```

| File | What it is |
|---|---|
| `src/embedders.ts` | One `Embedder` per provider SDK. It contains nothing mock-specific. |
| `src/tokens.ts` | One token counter per provider |
| `src/kb.ts` | The vector index, model picking, and the budgeted RAG answer |
| `test/kb.test.ts` | Tests |

> **About mock embeddings:** mock-llm's vectors are deterministic per text (seeded from a hash) and unit length, but
> they are **not semantic**. The same text always gets the same vector, and different texts are close to orthogonal.
> That's enough to test your pipeline: request shapes, decoding, batching, ranking code and prompt assembly. For
> ranking, it means only an exact text match is predictably the top result, which is why this FAQ matches questions to
> questions. Retrieval *quality* is a question for an eval against a real embedding model, not for a mock.
