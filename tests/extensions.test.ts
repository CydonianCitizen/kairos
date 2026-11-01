import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ExtensionHost, extractDescription } from '../src/extensions/host.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function setup() {
  const r = await mkdtemp(join(tmpdir(), 'nim-ext-'));
  roots.push(r);
  await mkdir(join(r, '.nim', 'skills', 'review'), { recursive: true });
  await writeFile(join(r, '.nim', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review changes\n---\nCheck correctness first.');
  await writeFile(join(r, 'AGENTS.md'), 'Use small changes.');
  return r;
}

it('loads explicit trusted skills and project instructions but never untrusted config', async () => {
  const r = await setup();
  await writeFile(join(r, '.nim', 'config.json'), '{bad config');
  const untrusted = await ExtensionHost.load(r, false, { loadGlobal: false });
  expect(untrusted.context()).toBe('');
  await untrusted.close();

  await writeFile(join(r, '.nim', 'config.json'), '{}');
  const host = await ExtensionHost.load(r, true, { loadGlobal: false });
  expect(host.context()).toContain('Use small changes');
  expect(host.context()).toContain('review');
  expect(await host.execute('load_skills_batch', { names: ['review'] })).toMatchObject({ ok: true });
  expect(JSON.stringify(await host.execute('load_skills_batch', { names: ['../secret'] }))).not.toContain('Use small');
  await host.close();
});

it('discovers global skills without workspace trust and allows workspace overrides when trusted', async () => {
  const r = await setup();
  const globalDir = await mkdtemp(join(tmpdir(), 'nim-global-skills-'));
  roots.push(globalDir);

  await mkdir(join(globalDir, 'global-helper'), { recursive: true });
  await writeFile(join(globalDir, 'global-helper', 'SKILL.md'), '---\nname: global-helper\ndescription: >\n  A global helper\n  skill for testing.\n---\nHelp globally.');

  await mkdir(join(globalDir, 'review'), { recursive: true });
  await writeFile(join(globalDir, 'review', 'SKILL.md'), '---\nname: review\ndescription: Global review fallback\n---\nGlobal review.');

  // Untrusted: loads global-helper and global review, but NOT untrusted workspace review or AGENTS.md
  const untrusted = await ExtensionHost.load(r, false, { globalSkillDirs: [globalDir] });
  expect(untrusted.skillNames).toContain('global-helper');
  expect(untrusted.skillNames).toContain('review');
  expect(untrusted.context()).toContain('A global helper skill for testing.');
  expect(untrusted.context()).toContain('Global review fallback');
  expect(untrusted.context()).not.toContain('Use small changes'); // Workspace AGENTS.md ignored
  const untrustedReview = await untrusted.execute('load_skills_batch', { names: ['review'] });
  expect(JSON.stringify(untrustedReview)).toContain('Global review.');
  await untrusted.close();

  // Trusted: workspace review overrides global review
  await writeFile(join(r, '.nim', 'config.json'), '{}');
  const trusted = await ExtensionHost.load(r, true, { globalSkillDirs: [globalDir] });
  expect(trusted.skillNames).toContain('global-helper');
  expect(trusted.skillNames).toContain('review');
  expect(trusted.context()).toContain('Use small changes');
  const trustedReview = await trusted.execute('load_skills_batch', { names: ['review'] });
  expect(JSON.stringify(trustedReview)).toContain('Check correctness first.'); // Workspace override won
  await trusted.close();
});

it('extracts skill descriptions across quotes, block scalars, and fallback formats', () => {
  expect(extractDescription('---\nname: a\ndescription: "Quoted text"\n---\nBody', 'a')).toBe('Quoted text');
  expect(extractDescription('---\nname: b\ndescription: >\n  First line\n  second line\n---\nBody', 'b')).toBe('First line second line');
  expect(extractDescription('---\nname: c\ndescription: |\n  Line 1\n  Line 2\n---\nBody', 'c')).toBe('Line 1 Line 2');
  expect(extractDescription('# Title\nNo frontmatter', 'fallback')).toBe('fallback');
});

it('validates plugin arguments, blocks plugin callbacks in plan mode and disposes resources', async () => {
  const r = await setup();
  await writeFile(join(r, '.nim', 'plugin.mjs'), `export default api=>{ api.registerTool({name:'double',description:'Double values',parameters:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false},execute:async args=>args.value*2}); api.registerCommand('hello',async args=>'hello '+args); };`);
  await writeFile(join(r, '.nim', 'config.json'), JSON.stringify({ plugins: ['.nim/plugin.mjs'] }));
  const host = await ExtensionHost.load(r, true, { loadGlobal: false });
  await host.prepare('plan');
  expect(host.commands).toEqual([]);
  await host.prepare('build');
  expect(await host.command('hello', 'world', 'build')).toBe('hello world');
  await expect(host.command('hello', '', 'plan')).rejects.toThrow(/plan/);
  const valid = await host.execute('extension_tools_batch', { calls: [{ name: 'double', arguments: { value: 4 } }] });
  expect(JSON.stringify(valid)).toContain('8');
  expect(await host.execute('extension_tools_batch', { calls: [{ name: 'double', arguments: { value: 'bad' } }] })).toMatchObject({ ok: false });
  expect(await host.execute('extension_tools_batch', { calls: [{ name: 'double', arguments: { value: 4 } }] }, undefined, 'plan')).toMatchObject({ ok: false });
  await host.close();
});

it('retries a failed plugin setup without retaining partially registered tools', async () => {
  const r = await setup();
  await writeFile(join(r, '.nim', 'retry.mjs'), `let attempt=0; export default api=>{api.registerTool({name:'retry',description:'retry',parameters:{type:'object'},execute:async()=>42}); if(attempt++===0)throw Error('temporary startup failure');};`);
  await writeFile(join(r, '.nim', 'config.json'), JSON.stringify({ plugins: ['.nim/retry.mjs'] }));
  const host = await ExtensionHost.load(r, true, { loadGlobal: false });
  await expect(host.prepare('build')).rejects.toThrow('temporary');
  await host.prepare('build');
  expect(await host.execute('extension_tools_batch', { calls: [{ name: 'retry', arguments: {} }] })).toMatchObject({ ok: true });
  await host.close();
});

it('resolves and activates skills using $ syntax in prompts and handles skill activation lifecycle', async () => {
  const r = await setup();
  const globalDir = await mkdtemp(join(tmpdir(), 'nim-skills-dollar-'));
  roots.push(globalDir);
  await mkdir(join(globalDir, 'caveman'), { recursive: true });
  await writeFile(join(globalDir, 'caveman', 'SKILL.md'), '---\nname: caveman\ndescription: Terse mode\n---\nBe brief.');
  await mkdir(join(globalDir, 'ponytail'), { recursive: true });
  await writeFile(join(globalDir, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: Minimal clean\n---\nMinimal code.');

  const host = await ExtensionHost.load(r, false, { globalSkillDirs: [globalDir] });
  expect(host.resolveSkillsFromPrompt('fai refactor con $caveman e $ponytail')).toEqual(['caveman', 'ponytail']);
  expect(host.resolveSkillsFromPrompt('$CAVEMAN solo')).toEqual(['caveman']);
  expect(host.resolveSkillsFromPrompt('costa $20 e usa $HOME')).toEqual([]);

  host.activateSkill('$caveman');
  expect(host.activeSkillNames).toEqual(['caveman']);
  expect(host.context()).toContain('User-selected skill caveman');
  expect(host.context()).toContain('Be brief.');

  host.clearActiveSkills();
  expect(host.activeSkillNames).toEqual([]);
  expect(host.context()).not.toContain('User-selected skill caveman');

  host.activateSkill('ponytail');
  expect(host.activeSkillNames).toEqual(['ponytail']);
  host.deactivateSkill('$ponytail');
  expect(host.activeSkillNames).toEqual([]);

  await host.close();
});
