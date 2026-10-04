import { startMockLLM } from 'mock-llm/playwright';

// Strict: an unscripted LLM request gets a 400 (so the app takes its error path).
// Returns the teardown that stops the mock after the run.
export default () => startMockLLM({ port: 4010, strict: true });
