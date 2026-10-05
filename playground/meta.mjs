// What the tutorial's Reference page and forms list (fault / edge / scenario names, default models), read from the
// built library. Served live as /api/meta by server.mjs and written as meta.json by the static build.
import { builtinScenarios, edge, faults } from '../dist/index.js';

export const DEFAULT_MODELS = {
  openai: 'gpt-4o',
  'openai-responses': 'gpt-4.1',
  anthropic: 'claude-opus-5-5',
  gemini: 'gemini-2.5-flash',
  bedrock: 'us.anthropic.claude-sonnet-5-5',
};

export const buildMeta = () => ({ scenarios: Object.keys(builtinScenarios), faults: Object.keys(faults), edge: Object.keys(edge), models: DEFAULT_MODELS });

/** Repo docs the Reference page links to (served at docs/<name>.md). */
export const DOCS = ['README', 'ROADMAP', 'CHANGELOG', 'RELEASING', 'CONTRIBUTING'];
