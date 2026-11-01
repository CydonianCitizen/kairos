import { DEFAULT_MODEL } from './models.js';

export const EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
// Endpoint-specific controls; do not infer support from the discovery list.
const supported: Readonly<Record<string, readonly Effort[]>> = {
  [DEFAULT_MODEL]: ['auto', 'none', 'high'],
  'minimaxai/minimax-m3.1-flash': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
};
export const effortLevels = (model: string): readonly Effort[] => supported[model] ?? ['auto'];
export function validateEffort(model: string, value: unknown): asserts value is Effort {
  if (!effortLevels(model).some(level => level === value)) throw new Error(`Effort for ${model}: choose ${effortLevels(model).join(', ')}`);
}
export function effortParameters(model: string, effort: Effort): {
  reasoning_effort?: Exclude<Effort, 'auto'>; chat_template_kwargs?: Record<string, unknown>;
} {
  validateEffort(model, effort);
  // Hosted Mistral rejects explicit none; omitting it selects the documented non-reasoning default.
  if (effort === 'auto' || (model === DEFAULT_MODEL && effort === 'none')) return {};
  return model === 'minimaxai/minimax-m3.1-flash' ? { chat_template_kwargs: { reasoning_effort: effort } } : { reasoning_effort: effort };
}
