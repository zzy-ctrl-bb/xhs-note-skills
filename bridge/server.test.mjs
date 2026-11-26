import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, rm, mkdir, readdir, readFile, stat, writeFile, symlink, cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {makeBridge,transport} from './server.mjs';

const server=fileURLToPath(new URL('./server.mjs',import.meta.url));
const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}}};
const initialized={jsonrpc:'2.0',method:'notifications/initialized'};
const parse = r=>JSON.parse(r.content[0].text);
async function workspace(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-xhs-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}

test('real stdio handshake negotiates one version, ignores notifications and lists tools', async(t)=>{
  const dir=await workspace(t);
  const proc=spawn(process.execPath,[server,'--workspace',dir],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(proc.exitCode===null) proc.kill();});
  const lines=createInterface({input:proc.stdout})[Symbol.asyncIterator]();
  const send=x=>proc.stdin.write(JSON.stringify(x)+'\n');
  const read=async()=>JSON.parse((await lines.next()).value);
  send(init);
  const hello=await read();
  assert.equal(hello.result.protocolVersion,'2025-06-18');
  send(initialized);
  send({jsonrpc:'2.0',id:2,method:'tools/list'});
  const listed=(await read()).result.tools.map(tool=>tool.name);
  assert.ok(listed.includes('view_image') && listed.includes('preview_note'));
  send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_inputs',arguments:{}}});
  assert.deepEqual(parse((await read()).result),{videos:[],notes:[]});
  const finish=once(proc,'close');
  proc.stdin.end();
  assert.equal((await finish)[0],0);
});

test('boundaries, validation and explicit permissions',async(t)=>{
  const dir=await workspace(t);
  const handle=transport(await makeBridge({workspace:dir,account:'sample',nickname:'Example'}));
  await handle(init); await handle(initialized);
  const call=async(name,args)=> (await handle({jsonrpc:'2.0',id:9,method:'tools/call',params:{name,arguments:args}})).result;
  for (const [name,args] of [
    ['acquire_video',{file:'../private.mov'}],['acquire_video',{file:'test.mp4',url:'x'}],
    ['acquire_video',{url:'https://xhslink.com/example',confirmPaid:true}],
    ['publish_note',{note:'demo',account:'sample',nickname:'Example',fingerprint:'a'.repeat(64),confirmSubmit:true}],
    ['login',{account:'wrong',nickname:'Example',confirmLogin:true}],
    ['login',{account:'sample',nickname:'Example',confirmLogin:false}],
    ['check_note',{note:'demo',arbitrary:'arg'}],['view_image',{note:'../secrets',image:'irrelevant'}],
    ['listen_clip',{sourceId:'a'.repeat(64),frameSet:'../private',start:1,end:2}],
  ]) assert.equal((await call(name,args)).isError,true);
  const outside=await workspace(t);
  await writeFile(path.join(outside,'private.mov'),'dummy');
  await symlink(path.join(outside,'private.mov'),path.join(dir,'inputs','aliased.mov'));
  assert.equal((await call('acquire_video',{file:'aliased.mov'})).isError,true);
  await symlink(outside,path.join(dir,'notes','linked'));
  assert.equal((await call('check_note',{note:'linked'})).isError,true);
  const {error}=await handle({jsonrpc:'2.0',id:15,method:'tools/call',params:{name:'shell',arguments:{cmd:'anything'}}});
  assert.equal(error.code,-32602);
});

test('local video via MCP including original image, audio, plan rendering and independent note check',async(t)=>{
  const dir=await workspace(t);
  const invoke=await makeBridge({workspace:dir});
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','testsrc=size=160x100:rate=5',
    '-f','lavfi','-i','sine=frequency=440','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',path.join(dir,'inputs','demo.mp4')]);
  const {sourceId}=parse(await invoke('acquire_video',{file:'demo.mp4'}));
  const p=parse(await invoke('prepare_frames',{sourceId,at:[0,.55],audio:true}));
  const ref={sourceId,frameSet:p.frameSet};
  assert.equal(p.frames.length,2);
  assert.ok((await invoke('view_image',{...ref,frame:'f01'})).content[0].data.startsWith('/9j/'));
  const sound=(await invoke('listen_clip',{...ref,start:0,end:0.2})).content[0];
  assert.equal(sound.mimeType,'audio/wav');
  assert.equal(Buffer.from(sound.data,'base64').toString('ascii',0,4),'RIFF');
  await assert.rejects(invoke('listen_clip',{...ref,start:0,end:21}),/20 seconds/);
  const plan=p.planTemplate;
  plan.title.text='Color and sound';
  plan.paragraphs=[{text:'The soundtrack starts with a tone.',audio_ranges:[[0,.2]]}];
  plan.pages=[{frame:'f01',caption:'First frame'},{frame:'f02',caption:'A later frame'}];
  const result=parse(await invoke('build_note',{...ref,plan}));
  assert.deepEqual(result.images,['cover.jpg','01.jpg']);
  assert.equal(parse(await invoke('build_note',{...ref,plan})).fingerprint,result.fingerprint);
  const payload=await invoke('view_image',{note:result.note,image:'cover.jpg'});
  assert.equal(payload.content[0].type,'image');
  await cp(path.join(dir,'notes',result.note),path.join(dir,'notes','independent'),{recursive:true});
  assert.equal(parse(await invoke('check_note',{note:'independent'})).fingerprint,result.fingerprint);
  await writeFile(path.join(dir,'notes',result.note,'title.txt'),'Edited version');
  await assert.rejects(invoke('build_note',{...ref,plan}),/package changed/);
  // No login session, provider call, or official submission is needed for this round trip.
});

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('a signed share uses one public-player process and clears the private input on failure',async(t)=>{
  const dir=await workspace(t);
  const share='https://www.xiaohongshu.com/explore/'+'a'.repeat(24)+'?example=test-only';
  let attempts=0, temporaryFile;
  const invoke=await makeBridge({workspace:dir,'allow-paid':true},{
    async runPublicPlayer(bin,argv,options) {
      attempts++;
      assert.equal(bin,process.execPath);
      assert.ok(argv[0].endsWith('download.mjs'));
      assert.equal(options.allowKey,false);
      assert.ok(!argv.includes(share) && !argv.includes('--url'));
      temporaryFile=argv[argv.indexOf('--url-file')+1];
      assert.equal(await readFile(temporaryFile,'utf8'),share);
      if(process.platform!=='win32') assert.equal((await stat(temporaryFile)).mode & 0o777,0o600);
      throw new Error('public source unavailable');
    }});
  await assert.rejects(invoke('acquire_video',{url:share}),/public source unavailable/);
  assert.equal(attempts,1);
  await assert.rejects(stat(temporaryFile),{code:'ENOENT'});
});

test('actual free downloader cache yields a verified source usable by prepare_frames',async(t)=>{
  const dir=await workspace(t), invoke=await makeBridge({workspace:dir});
  const note_id='b'.repeat(24),url='https://www.xiaohongshu.com/explore/'+note_id;
  const input_digest=sha256(url),sourceId=sha256('public:'+input_digest);
  const job=path.join(dir,'jobs',sourceId), cache=path.join(job,'source');
  await mkdir(cache,{recursive:true});
  const file=path.join(cache,'source.mp4');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=c=blue:s=160x100:r=5',
    '-t','1','-c:v','libx264','-pix_fmt','yuv420p',file]);
  const bytes=await readFile(file);
  const receipt={mode:'public_player',input_digest,note_id,sha256:sha256(bytes),width:160,height:100,duration:1,bytes:bytes.length};
  await writeFile(path.join(cache,'source.json'),JSON.stringify(receipt));
  const result=parse(await invoke('acquire_video',{url}));
  assert.equal(result.mode,'public_player');
  assert.equal(result.sourceId,sourceId);
  assert.deepEqual(await readdir(job),['source']);
  const prepared=parse(await invoke('prepare_frames',{sourceId,at:[0]}));
  assert.equal(prepared.frames.length,1);
  assert.ok((await invoke('view_image',{sourceId,frameSet:prepared.frameSet,frame:'f01'})).content[0].data.startsWith('/9j/'));
  await writeFile(path.join(cache,'source.json'),JSON.stringify({...receipt,note_id:'c'.repeat(24)}));
  await assert.rejects(invoke('acquire_video',{url}));
  await writeFile(path.join(cache,'source.json'),JSON.stringify({...receipt,note_id:'not-a-note'}));
  await assert.rejects(invoke('prepare_frames',{sourceId,at:[0]}),/receipt does not match/);
});

test('help displays usage without starting an MCP workspace',()=>{
  const help=execFileSync(process.execPath,[server,'--help'],{encoding:'utf8'});
  assert.match(help,/--workspace/);
  assert.match(help,/--nickname/);
});

test('official preview is bound to the requested account and current run; returns only its allowed screenshot',async(t)=>{
  const dir=await workspace(t), state=await workspace(t);
  const oldState=process.env.XHS_PUBLISH_STATE_DIR;
  process.env.XHS_PUBLISH_STATE_DIR=state;
  t.after(()=>{if(oldState===undefined) delete process.env.XHS_PUBLISH_STATE_DIR; else process.env.XHS_PUBLISH_STATE_DIR=oldState;});
  const fingerprint='d'.repeat(64), account='demo', nickname='Sample Creator';
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  let variant='phone', seq=0, previews=0;
  const invoke=await makeBridge({workspace:dir,account,nickname},{async runPublisher(binary,argv) {
    assert.equal(binary,process.execPath);
    assert.ok(argv[0].endsWith('cli.mjs'));
    const action=argv[1],argumentsList=argv.slice(3);
    if(action==='check') return {status:'checked',fingerprint};
    assert.equal(action,'preview');
    assert.deepEqual(argumentsList,['--account',account,'--nickname',nickname,'--json']);
    previews++;
    const stamp=new Date(variant==='stale'?0:Date.now()).toISOString().replace(/[:.]/gu,'-');
    const run=stamp+'-'+(++seq).toString(16).padStart(8,'0');
    const runDir=path.join(state,'runs',run);
    await mkdir(runDir,{recursive:true});
    const report={action:'preview',stage:'预览完成，已停在发布前',account,displayName:nickname,fingerprint,screenshots:['手机预览.png']};
    if(variant==='foreign-receipt') report.fingerprint='e'.repeat(64);
    if(variant==='unlisted') report.screenshots=['../private.png'];
    if(variant==='full') report.screenshots=['发布前预览.png'];
    if(variant==='linked') {
      await writeFile(path.join(state,'private.png'),png);
      await symlink(path.join(state,'private.png'),path.join(runDir,'手机预览.png'));
    } else if(variant==='oversize') {
      await writeFile(path.join(runDir,'手机预览.png'),Buffer.alloc(12*1024*1024+1));
    } else {
      await writeFile(path.join(runDir,variant==='full'?'发布前预览.png':'手机预览.png'),png);
    }
    await writeFile(path.join(runDir,'记录.json'),JSON.stringify(report));
    return {status:'previewed',account,displayName:nickname,fingerprint,runDir:variant==='outside'?dir:runDir};
  }});
  await mkdir(path.join(dir,'notes','demo'));
  const request={note:'demo',account,nickname,confirmPreview:true};
  await assert.rejects(invoke('preview_note',{...request,confirmPreview:false}),/Authorize/);
  await assert.rejects(invoke('preview_note',{...request,nickname:'other'}),/bound/);
  assert.equal(previews,0);
  for(variant of ['phone','full']){
    const response=await invoke('preview_note',request);
    assert.deepEqual(parse(response),{status:'previewed',note:'demo',account,nickname,fingerprint,published:false});
    assert.deepEqual(response.content[1],{type:'image',mimeType:'image/png',data:png.toString('base64')});
    assert.ok(!JSON.stringify(response).includes(state));
  }
  for(variant of ['unlisted','linked','oversize']){
    const response=await invoke('preview_note',request);
    assert.equal(parse(response).status,'previewed');
    assert.equal(response.content.filter(block=>block.type==='image').length,0);
    assert.ok(!JSON.stringify(response).includes(state));
  }
  for(variant of ['outside','foreign-receipt','stale']) await assert.rejects(invoke('preview_note',request),/receipt/i);
});
