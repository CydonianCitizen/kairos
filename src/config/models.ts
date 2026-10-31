export const NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_MODEL = 'mistralai/mistral-large-4-1t-a52b';
// Curated from NVIDIA Build on 2026-10-31; sources and budget policy: docs/MODELS.md.
// Only enable parallel calls when the hosted endpoint documents the parameter.
export const MODELS = [
  { id: DEFAULT_MODEL, temperature: 0.5, topP: 1, maxTokens: 4096, parallelToolCalls: false },
  { id: 'deepseek-ai/deepseek-v4.1-flash', temperature: 1, topP: 0.95, maxTokens: 16384, parallelToolCalls: false },
  { id: 'minimaxai/minimax-m3.1-flash', temperature: 1, topP: 0.95, maxTokens: 16384, parallelToolCalls: false },
  { id: 'z-ai/glm-5.3-flash', temperature: 0.5, topP: 1, maxTokens: 16384, parallelToolCalls: false },
  { id: 'nvidia/nemotron-3.5-bolt-e4b', temperature: 1, topP: 0.95, maxTokens: 16384, parallelToolCalls: true },
] as const;
