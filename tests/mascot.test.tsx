import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RoamingMascot } from '../src/ui/RoamingMascot.js';

const position = (frame: string) => frame.split('\n')[2]!.indexOf('▀█████▀');
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.9);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('walks with animated feet and moves faster while thinking', async () => {
  const app = render(<RoamingMascot columns={60} />);
  await advance(40);
  const start = app.lastFrame()!;
  await advance(280);
  expect(position(app.lastFrame()!)).toBe(position(start) + 1);
  expect(app.lastFrame()).toContain('▄▀▄');
  const walking = position(app.lastFrame()!);
  app.rerender(<RoamingMascot columns={60} mood="thinking" />);
  await advance(140);
  expect(position(app.lastFrame()!)).toBe(walking + 1);
  expect(app.lastFrame()).toContain('✦ ✦');
});

it('rests in place during pacing and errors and resumes walking afterward', async () => {
  const app = render(<RoamingMascot columns={60} />);
  await advance(600);
  const at = position(app.lastFrame()!);
  app.rerender(<RoamingMascot columns={60} mood="pacing" statusText="NIM cooldown" />);
  await advance(2000);
  expect(position(app.lastFrame()!)).toBe(at);
  expect(app.lastFrame()).toContain('─ ─');
  expect(app.lastFrame()).not.toContain('▄▀▄');
  app.rerender(<RoamingMascot columns={60} mood="error" statusText="Retry" />);
  await advance(2000);
  expect(position(app.lastFrame()!)).toBe(at);
  expect(app.lastFrame()).toContain('× ×');
  app.rerender(<RoamingMascot columns={60} mood="thinking" />);
  await advance(160);
  expect(position(app.lastFrame()!)).toBe(at + 1);
});

it('bounds the sprite and bubble after resizing and never wraps its four rows', async () => {
  const app = render(<RoamingMascot columns={80} statusText={'A long status '.repeat(10) + '\n\x1b[2Junsafe'} />);
  await advance(3000);
  for (const columns of [25, 12, 11]) {
    app.rerender(<RoamingMascot columns={columns} statusText={'A long status '.repeat(10) + '\n\x1b[2Junsafe'} />);
    await advance(600);
    const lines = app.lastFrame()!.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines.every(line => line.length <= columns)).toBe(true);
    expect(lines[2]).toContain('▀█████▀');
    expect(app.lastFrame()).not.toContain('\x1b');
  }
  app.rerender(<RoamingMascot columns={10} />);
  await advance(40);
  expect(app.lastFrame()).toBe('');
});

it('follows terminal resize events when used without an explicit width', async () => {
  const app = render(<RoamingMascot />);
  await advance(1000);
  Object.defineProperty(app.stdout, 'columns', { get: () => 12 });
  app.stdout.emit('resize');
  await advance(40);
  expect(app.lastFrame()!.split('\n').every(line => line.length <= 12)).toBe(true);
  expect(position(app.lastFrame()!)).toBe(3);
});

it('stops producing animation frames after unmount', async () => {
  const app = render(<RoamingMascot columns={60} />);
  await advance(300);
  app.unmount(); app.cleanup();
  await advance(40);
  const count = app.frames.length;
  await advance(2000);
  expect(app.frames).toHaveLength(count);
});
