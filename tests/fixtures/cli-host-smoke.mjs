// Run after npm run build. All inference is intercepted; no real credentials or network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'kairos-cli-host-'));
const home = join(root, 'home'), first = join(root, 'first'), second = join(root, 'second');
const log = join(root, 'requests.jsonl'), bootstrap = join(root, 'fake-nim.mjs');
const cli = resolve('dist/cli.js');
const environment = { ...process.env, HOME: home, USERPROFILE: home, KAIROS_SMOKE_LOG: log, NO_COLOR: '1' };
for (const key of Object.keys(environment)) if (/^(NVIDIA_API_KEY|NVIDIA_TIMEOUT_MS)$/i.test(key)) delete environment[key];
const config = JSON.stringify({ model: 'custom/personal', effort: 'auto', timeoutMs: 5000 }, null, 2);
function run(cwd, args, input = '') {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(bootstrap).href, cli, '--cwd', cwd, ...args], { cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI smoke process timed out')); }, 30000);
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolveRun({ code, stderr, rows: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }); }
      catch { reject(new Error(`Invalid CLI JSON: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}`)); }
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
const rpc = (...requests) => requests.map(([id, method, params]) => JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n') + '\n';
const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const result = response => response.rows.find(row => row.type === 'result');
try {
  await Promise.all([mkdir(join(home, '.kairos'), { recursive: true }), mkdir(first), mkdir(second)]);
  await writeFile(join(home, '.kairos/.env'), 'NVIDIA_API_KEY=fake-key-for-offline-smoke\n');
  await writeFile(join(home, '.kairos/config.json'), config);
  await writeFile(join(first, 'a.txt'), 'before');
  await writeFile(bootstrap, `import {appendFile} from 'node:fs/promises';
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init);const body=JSON.parse(await request.text());
 await appendFile(process.env.KAIROS_SMOKE_LOG,JSON.stringify(body)+'\\n');
 const prompt=body.messages.filter(message=>message.role==='user'&&typeof message.content==='string'&&!message.content.startsWith('Explicit user reference snapshots')).at(-1)?.content??'';
 const edit=prompt.startsWith('EDIT')&&body.messages.at(-1)?.role!=='tool';
 const background=prompt.startsWith('BACKGROUND')&&body.messages.at(-1)?.role!=='tool';
 const delta=background?{tool_calls:[{index:0,id:'background',type:'function',function:{name:'run_bash',arguments:JSON.stringify({command:'printf background-ready',background:true})}}]}:edit?{tool_calls:[{index:0,id:'edit',type:'function',function:{name:'apply_edits_batch',arguments:JSON.stringify({edits:[{path:'a.txt',old_text:'before',new_text:'after'}]})}}]}:{content:'Offline reply'};
 const chunk={id:'smoke',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta,finish_reason:edit||background?'tool_calls':'stop'}]};
 return new Response('data: '+JSON.stringify(chunk)+'\\n\\ndata: [DONE]\\n\\n',{status:200,headers:{'Content-Type':'text/event-stream'}});
};`);

  const denied = await run(first, ['--no-session', '--json', '--model', 'custom/chosen', '--prompt', 'EDIT']);
  assert.equal(denied.code, 1, denied.stderr); assert.equal(result(denied).result.status, 'error');
  assert.ok(denied.rows.some(row => row.type === 'tool_end' && row.data.result.approvalRequired));
  assert.equal(await readFile(join(first, 'a.txt'), 'utf8'), 'before');
  assert.equal((await requests()).length, 1, 'ask must stop before a second inference');
  assert.equal(JSON.parse(await readFile(join(home, '.kairos/last-model.json'), 'utf8')).model, 'custom/chosen');

  const edited = await run(first, ['--no-session', '--json', '--permissions', 'allow', '--prompt', 'EDIT @file:a.txt']);
  assert.equal(edited.code, 0, edited.stderr); assert.equal(await readFile(join(first, 'a.txt'), 'utf8'), 'after');
  const context = edited.rows.find(row => row.type === 'context' && row.data.references.length === 1).data;
  assert.ok(context.chars > 0 && context.chars <= context.maxChars && context.maxChars <= 12000);
  const afterEdit = await requests(); assert.ok(afterEdit[1].messages.some(message => message.content?.includes('before') && message.content?.includes('Explicit user reference snapshots')));
  assert.equal(afterEdit[1].model, 'custom/chosen');

  const restored = await run(first, ['--rpc', '--no-session', '--permissions', 'allow'], rpc([1, 'undo']));
  assert.equal(restored.code, 0, restored.stderr); assert.ok(restored.rows.find(row => row.id === 1).result.every(row => row.ok));
  assert.equal(await readFile(join(first, 'a.txt'), 'utf8'), 'before'); assert.equal((await requests()).length, afterEdit.length, 'undo uses no inference');

  const other = await run(second, ['--json', '--prompt', 'Create a saved session']);
  assert.equal(other.code, 0, other.stderr); assert.equal((await requests()).at(-1).model, 'custom/chosen');
  const sessionId = result(other).sessionId; assert.ok(sessionId);
  const selected = await run(first, ['--rpc', '--no-session'], rpc([1, 'model', { model: 'custom/rpc-choice' }], [2, 'queue']));
  assert.equal(selected.code, 0, selected.stderr); assert.equal(selected.rows.find(row => row.id === 1).result.model, 'custom/rpc-choice');
  assert.deepEqual(selected.rows.find(row => row.id === 2).result, { items: [], limit: 20 });
  assert.equal(JSON.parse(await readFile(join(home, '.kairos/last-model.json.bak'), 'utf8')).model, 'custom/chosen');

  const latest = await run(first, ['--no-session', '--json', '--prompt', 'New session after RPC selection']);
  assert.equal(latest.code, 0, latest.stderr); assert.equal((await requests()).at(-1).model, 'custom/rpc-choice');
  const resumed = await run(second, ['--session', sessionId, '--json', '--prompt', 'Resume saved model']);
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal((await requests()).at(-1).model, 'custom/chosen');
  assert.equal(JSON.parse(await readFile(join(home, '.kairos/last-model.json'), 'utf8')).model, 'custom/rpc-choice', 'resume must not overwrite manual preference');
  assert.equal(await readFile(join(home, '.kairos/config.json'), 'utf8'), config);
  const checkpointed = await run(first,['--json','--permissions','allow','--prompt','EDIT']);
  assert.equal(checkpointed.code,0,checkpointed.stderr);const checkpointSession=result(checkpointed).sessionId;
  assert.equal(await readFile(join(first,'a.txt'),'utf8'),'after');
  const pointList=await run(first,['--rpc','--session',checkpointSession],rpc([1,'rewindPoints']));
  const point=pointList.rows.find(row=>row.id===1).result[0];assert.equal(point.prompt,'EDIT');
  const countBeforeRewind=(await requests()).length;
  const rewind=await run(first,['--rpc','--session',checkpointSession,'--permissions','allow'],rpc([1,'rewind',{id:point.id,scope:'both'}]));
  assert.equal(rewind.code,0,rewind.stderr);assert.equal(rewind.rows.find(row=>row.id===1).result.ok,true);
  assert.equal(await readFile(join(first,'a.txt'),'utf8'),'before');assert.equal((await requests()).length,countBeforeRewind);

  const note=await run(first,['--rpc','--no-session'],rpc([1,'updateMemory',{changes:[{action:'add',text:'Prefer focused Windows tests.'}]}]));
  assert.equal(note.code,0,note.stderr);assert.equal(note.rows.find(row=>row.id===1).result[0].text,'Prefer focused Windows tests.');
  const withMemory=await run(first,['--no-session','--json','--prompt','Use saved preferences']);assert.equal(withMemory.code,0,withMemory.stderr);
  assert.ok((await requests()).at(-1).messages.some(message=>message.content?.includes('Prefer focused Windows tests.')));
  const withoutMemory=await run(first,['--no-session','--no-memory','--json','--prompt','Disable saved preferences']);assert.equal(withoutMemory.code,0,withoutMemory.stderr);
  assert.ok(!(await requests()).at(-1).messages.some(message=>message.content?.includes('Prefer focused Windows tests.')));

  await writeFile(join(home,'.kairos/config.json.bak'),config);
  const restricted=JSON.stringify({...JSON.parse(config),permissions:{edits:'allow',rules:[{kind:'edits',mode:'deny',pattern:'a.txt'}]}});
  await writeFile(join(home,'.kairos/config.json'),restricted);
  const policy=await run(first,['--no-session','--json','--permissions','allow','--prompt','EDIT']);
  assert.equal(policy.code,0,policy.stderr);assert.ok(policy.rows.some(row=>row.type==='tool_end'&&row.data.result.permissionDenied));
  assert.equal(await readFile(join(first,'a.txt'),'utf8'),'before');assert.equal(await readFile(join(home,'.kairos/config.json'),'utf8'),restricted);
  const background=await run(first,['--no-session','--json','--permissions','allow','--prompt','BACKGROUND']);
  assert.equal(background.code,0,background.stderr);assert.equal(result(background).result.status,'completed');
  assert.ok(background.rows.some(row=>row.type==='tool_end'&&row.data.name==='run_bash'&&row.data.result.ok&&row.data.result.result.id),JSON.stringify(background.rows.filter(row=>row.type==='tool_end'))+' '+background.stderr);
  assert.ok(background.rows.some(row=>row.type==='background_tasks'&&row.data.some(task=>task.status==='completed')));
  console.log('CLI smoke passed: approvals and granular deny, supervised background shell, bounded references, persistent undo/rewind across restart, project memory opt-out, cross-workspace model memory and RPC. No real inference.');
} finally {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'kairos-cli-host-')) throw new Error('Unexpected fixture path');
  await rm(root, { recursive: true, force: true });
}
