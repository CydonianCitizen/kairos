import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findBash, resetBashCache } from '../src/core/shell-runner.js';
import { FsTools } from '../src/tools/fs-tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Bash Detection and Fallback', () => {
  const trackedVars = [
    'BASH_PATH',
    'ProgramFiles',
    'PROGRAMFILES',
    'ProgramFiles(x86)',
    'PROGRAMFILES(X86)',
    'LOCALAPPDATA',
    'USERPROFILE',
    'ProgramData',
    'ChocolateyInstall',
    'PATH',
    'Path',
  ];
  let savedEnv: Record<string, string | undefined> = {};
  let tempDir: string;

  beforeEach(async () => {
    resetBashCache();
    savedEnv = {};
    for (const v of trackedVars) {
      savedEnv[v] = process.env[v];
    }
    tempDir = await mkdtemp(join(tmpdir(), 'kairos-bash-test-'));
  });

  afterEach(async () => {
    for (const v of trackedVars) {
      if (savedEnv[v] !== undefined) {
        process.env[v] = savedEnv[v];
      } else {
        delete process.env[v];
      }
    }
    resetBashCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prefers explicit bashPath when provided', async () => {
    const custom = 'C:\\custom\\path\\bash.exe';
    const found = await findBash(custom);
    expect(found).toBe(custom);
  });

  it('prefers BASH_PATH environment variable over auto-detection', async () => {
    process.env.BASH_PATH = 'C:\\env\\bash.exe';
    const found = await findBash();
    expect(found).toBe('C:\\env\\bash.exe');
  });

  it('auto-detects a valid bash executable on Windows when available', async () => {
    if (process.platform !== 'win32') return;
    delete process.env.BASH_PATH;
    const found = await findBash();
    expect(found).toBeTruthy();
    expect(found.toLowerCase()).toContain('bash.exe');
  });

  it('caches the auto-detected bash path for subsequent calls', async () => {
    if (process.platform !== 'win32') return;
    delete process.env.BASH_PATH;
    const first = await findBash();
    const second = await findBash();
    expect(second).toBe(first);
  });

  it('clears cache when resetBashCache is called', async () => {
    if (process.platform !== 'win32') return;
    delete process.env.BASH_PATH;
    const first = await findBash();
    resetBashCache();
    const second = await findBash();
    expect(second).toBe(first);
  });

  it('provides a descriptive error when no bash is found on Windows', async () => {
    if (process.platform !== 'win32') return;
    delete process.env.BASH_PATH;
    process.env.PATH = 'C:\\non-existent-directory';
    process.env.Path = 'C:\\non-existent-directory';
    process.env.ProgramFiles = 'C:\\non-existent-directory';
    process.env.PROGRAMFILES = 'C:\\non-existent-directory';
    process.env['ProgramFiles(x86)'] = 'C:\\non-existent-directory';
    process.env['PROGRAMFILES(X86)'] = 'C:\\non-existent-directory';
    process.env.LOCALAPPDATA = 'C:\\non-existent-directory';
    process.env.USERPROFILE = 'C:\\non-existent-directory';
    process.env.ProgramData = 'C:\\non-existent-directory';
    delete process.env.ChocolateyInstall;

    await expect(findBash()).rejects.toThrow(/No compatible Bash executable found on Windows/);
  });

  it('gracefully handles missing bash in FsTools.run_bash without throwing', async () => {
    if (process.platform !== 'win32') return;
    delete process.env.BASH_PATH;
    process.env.PATH = 'C:\\non-existent-directory';
    process.env.Path = 'C:\\non-existent-directory';
    process.env.ProgramFiles = 'C:\\non-existent-directory';
    process.env.PROGRAMFILES = 'C:\\non-existent-directory';
    process.env['ProgramFiles(x86)'] = 'C:\\non-existent-directory';
    process.env['PROGRAMFILES(X86)'] = 'C:\\non-existent-directory';
    process.env.LOCALAPPDATA = 'C:\\non-existent-directory';
    process.env.USERPROFILE = 'C:\\non-existent-directory';
    process.env.ProgramData = 'C:\\non-existent-directory';
    delete process.env.ChocolateyInstall;

    const tools = new FsTools(tempDir);
    const result = await tools.run_bash('echo "hello"');
    expect(result.exitCode).toBeNull();
    expect(result.error).toMatch(/No compatible Bash executable found on Windows/);
    await tools.close();
  });
});
