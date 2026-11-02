import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const lockIO = vi.hoisted(() => ({
  path: '', deletingPath: '', armed: false, denyOpen: false,
  entered: undefined as (() => void) | undefined,
  resume: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (path === lockIO.deletingPath || (lockIO.denyOpen && path === lockIO.path))
        return Promise.reject(Object.assign(new Error('Lock cannot be opened'), { code: 'EPERM', syscall: 'open' }));
      return actual.open(...args);
    },
    unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
      const name = String(path);
      if (lockIO.armed && name.startsWith(lockIO.path) && !name.endsWith('.tmp')) {
        lockIO.armed = false;
        lockIO.deletingPath = name;
        lockIO.entered!();
        await lockIO.resume;
        lockIO.deletingPath = '';
      }
      return actual.unlink(path);
    },
  };
});

let root: string;
let workspace: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairos-memory-lock-'));
  workspace = join(root, 'workspace'); directory = join(root, 'memory');
  await mkdir(workspace);
  Object.assign(lockIO, { path: '', deletingPath: '', armed: false, denyOpen: false, entered: undefined, resume: undefined });
});
afterEach(async () => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-memory-lock-')) throw new Error('Unexpected test directory');
  await rm(root, { recursive: true, force: true });
});

async function memoryFile(): Promise<string> {
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return join(directory, names[0]!, 'notes.json');
}

it('allows another owner to commit while the released lock is pending deletion', async () => {
  // Separate module queues model independent processes sharing one real store.
  vi.resetModules();
  const { ProjectMemory: OwnerMemory } = await import('../src/core/project-memory.js');
  vi.resetModules();
  const { ProjectMemory: ContenderMemory } = await import('../src/core/project-memory.js');
  const owner = new OwnerMemory(workspace, { directory });
  const contender = new ContenderMemory(workspace, { directory });
  await owner.update([{ action: 'add', text: 'Initial convention.' }]);
  lockIO.path = await memoryFile() + '.lock';
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { lockIO.entered = resolve; });
  lockIO.resume = new Promise<void>(resolve => { resume = resolve; });
  lockIO.armed = true;
  const ownerResult = owner.update([{ action: 'add', text: 'Owner convention.' }]).then(
    notes => ({ ok: true as const, notes }), error => ({ ok: false as const, error }),
  );
  try {
    await Promise.race([entered, ownerResult.then(result => { throw new Error(`Owner did not reach lock deletion: ${result.ok}`); })]);
    // Windows denies opening a name pending deletion. A new owner must be
    // able to use the shared name before the previous private deletion ends.
    const contenderResult = await contender.update([{ action: 'add', text: 'Contender convention.' }]).then(
      notes => ({ ok: true as const, notes }), error => ({ ok: false as const, error }),
    );
    expect(contenderResult).toMatchObject({ ok: true });
  } finally {
    resume();
    expect(await ownerResult).toMatchObject({ ok: true });
  }
  expect((await owner.list()).map(note => note.text).sort()).toEqual([
    'Initial convention.', 'Owner convention.', 'Contender convention.',
  ].sort());
});

it('preserves notes and the public lock when opening it persistently returns EPERM', async () => {
  vi.resetModules();
  const { ProjectMemory } = await import('../src/core/project-memory.js');
  const memory = new ProjectMemory(workspace, { directory });
  await memory.update([{ action: 'add', text: 'Preserve committed notes.' }]);
  const file = await memoryFile();
  const before = await readFile(file, 'utf8');
  const owner = JSON.stringify({ version: 1, pid: process.pid, id: randomUUID() });
  lockIO.path = file + '.lock';
  await writeFile(lockIO.path, owner);
  lockIO.denyOpen = true;
  await expect(memory.update([{ action: 'add', text: 'A blocked convention.' }])).rejects.toThrow(/lock.*unreadable/i);
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readFile(lockIO.path, 'utf8')).toBe(owner);
});
