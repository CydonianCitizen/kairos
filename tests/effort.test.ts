import { expect, it } from 'vitest';
import { effortParameters } from '../src/config/effort.js';
import { DEFAULT_MODEL } from '../src/config/models.js';

it('selects the documented non-reasoning default without sending the rejected explicit none parameter', () => {
  expect(effortParameters(DEFAULT_MODEL, 'none')).toEqual({});
  expect(effortParameters(DEFAULT_MODEL, 'high')).toEqual({ reasoning_effort: 'high' });
});
