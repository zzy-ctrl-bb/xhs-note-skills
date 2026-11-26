import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acquire, sourceLink, confirmedTarget, observedSize, matchMedia, fetchVideo } from './download.mjs';

const id='a'.repeat(24), asset='https://sns-v28.rednotecdn.com/demo.mp4';
const player={id,title:'演示作品',duration:3.5,width:160,height:90,at:0.9,count:1,src:'blob:https://www.xiaohongshu.com/example'};
const media=new Map([[asset,{size:120000}]]);
test('CLI help works without a browser, credentials or npm dependencies',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'xhs-help-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const cli=path.join(tmp,'download.mjs');
  await copyFile(new URL('./download.mjs',import.meta.url),cli);
  const run=promisify(execFile);
  for(const option of ['--help','-h']) {
    const {stdout}=await run(process.execPath,[cli,option],{cwd:tmp,env:{PATH:''}});
    for(const flag of ['--url-file','--url ','--out','--headless','--help'])assert.ok(stdout.includes(flag));
  }
  assert.deepEqual(await readdir(tmp),['download.mjs']);
});
test('only accepts single official note and short URLs, including share text',()=>{
  const link='https://www.xiaohongshu.com/discovery/item/'+id;
  assert.equal(sourceLink('一条笔记 '+link),link);
  assert.equal(sourceLink('http://xhslink.com/a/demo'),'https://xhslink.com/a/demo');
  for(const value of ['https://example.com/test','https://www.xiaohongshu.com/login',link+' '+link,'https://name@xhslink.cn/path','https://xhslink.com:400/path'])
    assert.throws(()=>sourceLink(value));
});
test('official Xiaohongshu to Rednote navigation must preserve target identity',()=>{
  const original='https://www.xiaohongshu.com/discovery/item/'+id;
  for(const host of ['www.rednote.com','rednote.com']) {
    const final='https://'+host+'/discovery/item/'+id;
    assert.equal(sourceLink(final),final);
    assert.equal(confirmedTarget(original,final),id);
    assert.throws(()=>confirmedTarget(original,final.replace(id,'b'.repeat(24))));
  }
  for(const host of ['rednote.com.example.org','www.rednote.com.evil.test','other.rednote.com','redn0te.com'])
    assert.throws(()=>confirmedTarget(original,'https://'+host+'/discovery/item/'+id));
});
test('only accepts unique, actually playing source with stable length and no protection',()=>{
  assert.deepEqual(matchMedia(player,media),{url:asset,size:120000});
  for(const changes of [{count:0},{count:2},{at:0},{restricted:true},{encrypted:true},{title:''},{duration:Infinity},{src:'https://sns-v28.rednotecdn.com/other.mp4'}])
    assert.throws(()=>matchMedia({...player,...changes},media));
  assert.throws(()=>matchMedia(player,new Map([[asset,{size:4,conflict:true}]])));
  assert.throws(()=>matchMedia(player,new Map([[asset,{size:4}],['https://sns-v28.rednotecdn.com/other.mp4',{size:9}]])));
  assert.throws(()=>matchMedia(player,new Map([['https://outside.invalid/demo.mp4',{size:9}]])));
});
test('valid partial responses describe the full resource size',()=>{
  assert.equal(observedSize(206,{'content-range':'bytes 0-9/120000'}),120000);
  assert.equal(observedSize(206,{'content-range':'bytes 0-120000/120000'}),0);
  assert.equal(observedSize(200,{'content-length':'120000'}),120000);
  assert.equal(observedSize(403,{'content-length':'128'}),0);
});
test('stream copy forbids redirects and credentials and detects truncation',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'xhs-public-media-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const data=Buffer.from('public fixture');
  const respond=async(url,opts)=>{
    assert.equal(url,asset);assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');
    assert.equal(opts.headers.Referer,undefined);assert.equal(opts.headers.Cookie,undefined);assert.equal(opts.headers.Authorization,undefined);
    return {status:200,url,body:[data],headers:new Headers({'Content-Length':String(data.length)})};
  };
  const target=path.join(tmp,'example.mp4'),got=await fetchVideo({url:asset,size:data.length},target,respond);
  assert.deepEqual(await readFile(target),data);assert.equal(got.sha256,createHash('sha256').update(data).digest('hex'));
  await assert.rejects(fetchVideo({url:asset,size:data.length+1},path.join(tmp,'broken'),respond));
  await assert.rejects(fetchVideo({url:asset,size:data.length},path.join(tmp,'short'),async()=>({
    status:200,url:asset,body:[data.subarray(1)],headers:new Headers()})));
});

test('acquire verifies a complete source, commits the receipt and reuses the cache',async t=>{
  const exec=promisify(execFile);
  const tmp=await mkdtemp(path.join(os.tmpdir(),'xhs-acquire-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const fixture=path.join(tmp,'fixture.mp4');
  try {
    await exec('ffprobe',['-version']);
    await exec('ffmpeg',['-v','error','-f','lavfi','-i','color=size=160x90:rate=5:duration=1','-c:v','mpeg4',fixture]);
  } catch(error) {
    if(error.code==='ENOENT')return t.skip('ffmpeg and ffprobe are required for the MP4 integration fixture');
    throw error;
  }
  const data=await readFile(fixture),share='https://www.rednote.com/explore/'+id;
  const out=path.join(tmp,'result');
  const result=await acquire(share,out,true,{
    capturePlayer:async(_share,_headless,consume)=>consume({...player,duration:1},{url:asset,size:data.length}),
    request:async url=>({url,status:200,body:[data],headers:new Headers()}),
  });
  assert.equal(result.status,'ready');
  assert.deepEqual(await readFile(result.video),data);
  const receipt=JSON.parse(await readFile(path.join(out,'source.json'),'utf8'));
  assert.equal(receipt.note_id,id);
  assert.equal(receipt.bytes,data.length);
  assert.equal(receipt.sha256,createHash('sha256').update(data).digest('hex'));
  assert.equal(receipt.duration,1);
  assert.equal(receipt.width,160);
  assert.equal(receipt.height,90);
  assert.deepEqual(await acquire(share,out,true,{capturePlayer:()=>assert.fail('unexpected browser fetch')}),result);
  assert.deepEqual((await readdir(tmp)).sort(),['fixture.mp4','result']);
});
