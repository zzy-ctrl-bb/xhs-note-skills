#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
const exec=promisify(execFile);
const officialDomains=new Set(['www.xiaohongshu.com','xiaohongshu.com','www.rednote.com','rednote.com']);
const hosts=new Set([...officialDomains,'xhslink.com','www.xhslink.com','xhslink.cn','www.xhslink.cn']);
const notePath=/^\/(?:explore|discovery\/item|user\/profile\/[0-9a-f]{24})\/([0-9a-f]{24})\/?$/i;
const cdn=/^sns-v\d{1,3}\.(?:rednotecdn\.com|xhscdn\.com)$/i;
const limit=2*1024**3;
function requireThat(value,reason){ if(!value) throw Object.assign(new Error(reason),{safe:true}); }
async function stage(label,work) {
  try {return await work();} catch(error) {
    if(error?.safe)throw error;
    // Report a bounded diagnostic code, never exception text containing the private share URL.
    const codes=[error?.cause?.code,error?.code,error?.name];
    const code=codes.find(value=>typeof value==='string' && /^(?:E[A-Z0-9_]{2,30}|UND_ERR_[A-Z_]+|TimeoutError|AbortError)$/.test(value));
    throw Object.assign(new Error(code ? `${label}（${code}）` : label),{safe:true});
  }
}
function urlOf(raw) { try {return new URL(raw);} catch {return null;} }
function allowed(url) {return url && /^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port;}
function pageURL(raw) {const u=urlOf(raw); return allowed(u) && hosts.has(u.hostname);}
function noteId(raw) {const u=urlOf(raw);return pageURL(raw) && officialDomains.has(u.hostname) ? notePath.exec(u.pathname)?.[1].toLowerCase() : undefined;}
export function confirmedTarget(share,finalPage) {
  const id=noteId(finalPage), original=noteId(share);
  requireThat(pageURL(share) && id && (!original||id===original),'页面要求登录、链接失效或作品 ID 未能确认。');
  return id;
}
export function sourceLink(text) {
  const links=text.trim().match(/https?:\/\/[^\s<>「」【】（）()，。；！？、"']+/gi);
  requireThat(links?.length===1 && pageURL(links[0]),'请提供一条小红书笔记长链或官方短链。');
  const u=new URL(links[0]);u.protocol='https:';u.hash='';
  requireThat(noteId(u.href) || /^(?:www\.)?xhslink\.(?:com|cn)$/.test(u.hostname) && u.pathname!=='/', '链接未指向已支持的单条小红书笔记。');
  return u.href;
}
function mediaURL(raw) {
  const u=urlOf(raw);
  return allowed(u) && u.protocol==='https:' && cdn.test(u.hostname) && /\.mp4$/i.test(u.pathname);
}
export function observedSize(status,headers) {
  if(status===206){
    const m=/^bytes (\d+)-(\d+)\/(\d+)$/i.exec(headers['content-range']||'');
    if(!m || +m[1]>+m[2] || +m[2]>=+m[3]) return 0;
    return +m[3];
  }
  return status===200 && /^\d+$/.test(headers['content-length']||'') ? +headers['content-length'] : 0;
}
export function matchMedia(player,media) {
  requireThat(player.count===1 && player.at>0 && Number.isFinite(player.duration) && player.duration>0 &&
    player.width>0 && player.height>0 && player.title?.trim() && player.id, '未核对到正在播放的唯一目标作品。');
  requireThat(!player.encrypted && !player.restricted,'网页限制保存或受保护，请提供有权使用的本地原片。');
  requireThat(media.size===1,'播放器没有提供唯一可核对的视频文件，请提供本地原片。');
  const [url,asset]=[...media][0];
  requireThat(mediaURL(url) && (player.src===url || player.src?.startsWith('blob:')) && !asset.conflict,
    '网页播放内容与观察到的媒体文件不一致。');
  requireThat(!asset.size || (Number.isSafeInteger(asset.size) && asset.size>0 && asset.size<=limit),'官网视频大小超限。');
  return {url,size:asset.size};
}
async function inspect(page) {
  return page.evaluate(()=>{
    const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0 && r.height>0 && s.display!=='none' && s.visibility!=='hidden';};
    const videos=[...document.querySelectorAll('video')].filter(shown),v=videos[0];
    const guard=[...document.querySelectorAll('[role=dialog],dialog,.login-container,.login-modal,.captcha-modal')].some(e=>shown(e) && /登录|验证码|安全验证|sign in|log in/i.test(e.innerText || ''));
    return {count:videos.length,duration:v?.duration,width:v?.videoWidth,height:v?.videoHeight,at:v?.currentTime,src:v?.currentSrc||v?.src||'',
      title:document.title,encrypted:!!v?.mediaKeys||window.__xhsSourceEncrypted===true,
      restricted:guard||!!v?.controlsList?.contains('nodownload'),href:location.href};
  });
}
async function capture(share, headless, consume) {
  const {chromium}=await stage('无法载入 playwright-core，请先运行本入口的 npm ci。',()=>import('playwright-core'));
  const browser=await stage('本机 Chrome 启动失败。',()=>chromium.launch({channel:'chrome',headless}));
  try {
    const context=await browser.newContext({locale:'zh-CN',acceptDownloads:false});
    const page=await context.newPage(),media=new Map();
    await context.route('**/*',route=>{
      const r=route.request();
      try {if(r.isNavigationRequest() && r.frame()===page.mainFrame() && !pageURL(r.url())) return route.abort();} catch {if(r.isNavigationRequest() && !pageURL(r.url())) return route.abort();}
      return route.continue();
    });
    await page.addInitScript(()=>{document.addEventListener('encrypted',()=>{window.__xhsSourceEncrypted=true;},true);});
    page.on('response',res=>{
      try{
        const r=res.request(),raw=res.url(),u=urlOf(raw),h=res.headers(),status=res.status();
        if(!allowed(u) || !/(?:^|\.)(?:rednotecdn\.com|xhscdn\.com)$/.test(u.hostname) ||
           ![200,206].includes(status) || r.frame()!==page.mainFrame())return;
        if(r.resourceType()!=='media' && !/^(video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl))/i.test(h['content-type']||'') && !/\.(?:mp4|m3u8|m4s)$/i.test(u.pathname))return;
        const size=observedSize(status,h), old=media.get(raw);
        media.set(raw,{size:size||old?.size||0,conflict:old?.conflict||Boolean(size && old?.size && size!==old.size)});
      }catch { /* Detached frames cannot supply a target media receipt. */ }
    });
    await stage('匿名 Chrome 未能打开官方分享页面。',()=>page.goto(share,{waitUntil:'domcontentloaded',timeout:90000}));
    const target=confirmedTarget(share,page.url());
    const video=page.locator('video:visible');
    await video.first().waitFor({timeout:100000}).catch(()=>{});
    requireThat(await video.count()===1,'匿名页面没有展示唯一的可见播放器。');
    await video.evaluate(v=>{v.muted=true;void v.play().catch(()=>{});});
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.getBoundingClientRect().width && v.currentTime>0.6 && v.videoWidth>0),undefined,{timeout:20000}).catch(()=>{});
    const check=async()=>{
      const p=await inspect(page);p.id=noteId(p.href);
      requireThat(p.id===target,'播放期间作品发生变化。');
      return {p,asset:matchMedia(p,media)};
    };
    const initial=await check();
    const result=await consume(initial.p,initial.asset);
    const final=await check();
    requireThat(initial.asset.url===final.asset.url && initial.p.width===final.p.width &&
      initial.p.height===final.p.height && initial.p.duration===final.p.duration,'播放源发生变化，请重新核对原片。');
    return result;
  }finally{await browser.close();}
}
export async function fetchVideo(asset,dest,request=fetch){
  requireThat(mediaURL(asset.url),'媒体来源无效。');
  const response=await request(asset.url,{redirect:'error',credentials:'omit',headers:{
    Accept:'video/mp4,application/octet-stream','Accept-Encoding':'identity'},signal:AbortSignal.timeout(300000)});
  requireThat(response.status===200 && response.url===asset.url && response.body,'公开文件暂时无法完整读取。');
  const length=response.headers.get('content-length');
  requireThat(length===null || /^\d+$/.test(length),'下载长度无效。');
  const expected=Number(length)||asset.size||0;
  requireThat(expected<=limit && (!asset.size||!length||asset.size===expected),'下载长度与播放器不符。');
  const enc=response.headers.get('content-encoding');
  requireThat(!enc||enc==='identity','视频传输编码不符合预期。');
  const hash=createHash('sha256'),file=await open(dest,'wx',0o600);let bytes=0;
  try{
    for await (const chunk of response.body) {
      bytes+=chunk.byteLength;
      requireThat(bytes<=limit && (!expected || bytes<=expected),'视频超过允许的长度。');
      await file.writeFile(chunk);hash.update(chunk);
    }
    requireThat(bytes>0 && (!expected || bytes===expected),'视频传输不完整。');
    await file.sync();
  }finally{await file.close();}
  return {bytes,sha256:hash.digest('hex')};
}
async function ffprobe(file,p) {
  const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov','-select_streams','V:0',
    '-count_packets','-show_entries','stream=width,height,nb_read_packets:stream_side_data=rotation:format=duration,size','-of','json',file],{timeout:180000,maxBuffer:1024*1024});
  const info=JSON.parse(stdout),v=info.streams?.[0],f=info.format,duration=Number(f?.duration);
  const rotated=Math.abs(v?.side_data_list?.find(s=>s.rotation)?.rotation||0)%180===90;
  const width=rotated?v?.height:v?.width,height=rotated?v?.width:v?.height;
  requireThat(Number(v?.nb_read_packets)>0 && width===p.width && height===p.height && Number.isFinite(duration) && Math.abs(duration-p.duration)<=0.5,'本地文件尺寸或时长与官网播放器不符。');
  return {duration,width,height,bytes:Number(f.size)};
}
async function digestFile(file){const h=createHash('sha256');for await (const b of createReadStream(file))h.update(b);return h.digest('hex');}
export async function acquire(share,output,headless=false,{capturePlayer=capture,request=fetch}={}) {
  const out=path.resolve(output),identity=createHash('sha256').update(share).digest('hex');
  const exists=await lstat(out).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(exists){
    requireThat(exists.isDirectory()&&!exists.isSymbolicLink(),'目标目录无效。');
    const rec=await readFile(path.join(out,'source.json'),'utf8').then(JSON.parse).catch(()=>null);
    requireThat(rec && rec.mode==='public_player' && (rec.input_digest===identity || noteId(share) && rec.note_id===noteId(share)),'请指定该作品专用的新输出目录。');
    const file=path.join(out,'source.mp4'),stat=await lstat(file);
    requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===rec.bytes && await digestFile(file)===rec.sha256,'缓存的视频与记录不符。');
    return {status:'ready',...rec,video:file};
  }
  await exec('ffprobe',['-version'],{timeout:10000}).catch(()=>requireThat(false,'请先安装独立 ffprobe 并加入 PATH。'));
  const parent=path.dirname(out);await mkdir(parent,{recursive:true,mode:0o700});
  const stageDir=await mkdtemp(path.join(parent,'.public-player-'));
  try{
    const file=path.join(stageDir,'source.mp4');
    const receipt=await capturePlayer(share,headless,async(p,asset)=>{
      const written=await stage('播放器文件下载失败，请检查本机访问官网媒体的网络连接。',()=>fetchVideo(asset,file,request));
      const probe=await stage('下载已结束，ffprobe 无法核验原片。',()=>ffprobe(file,p));
      requireThat(written.bytes===probe.bytes,'下载和解码文件大小不一致。');
      return {mode:'public_player',input_digest:identity,note_id:p.id,title:p.title,sha256:written.sha256,...probe};
    });
    await writeFile(path.join(stageDir,'source.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
    await rename(stageDir,out);
    return {status:'ready',...receipt,video:path.join(out,'source.mp4')};
  }finally{await rm(stageDir,{recursive:true,force:true});}
}
async function main(){
  const {values}=parseArgs({options:{url:{type:'string'},'url-file':{type:'string'},out:{type:'string'},headless:{type:'boolean'},help:{type:'boolean',short:'h'}}});
  if(values.help)return `用法：node download.mjs (--url-file 分享链接.txt | --url "分享文案") --out 原片目录 [--headless]
  --url-file    从 UTF-8 文本读取一条官方分享链接或分享文案
  --url         直接传入一条分享链接或分享文案
  --out         本作品专用目录，成功后写入 source.mp4 和 source.json
  --headless    隐藏 Chrome 窗口
  -h, --help    显示此说明`;
  requireThat(!!values.url!==!!values['url-file'] && values.out,'请指定 --url 或 --url-file，以及 --out 新目录。');
  const raw=values.url ?? await readFile(values['url-file'],'utf8');
  return acquire(sourceLink(raw),values.out,values.headless||false);
}
if(process.argv[1] && await realpath(process.argv[1]).catch(()=>null)===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  try{
    const result=await main();
    console.log(typeof result==='string'?result:JSON.stringify(result));
  }catch(e){
    console.log(JSON.stringify({status:'needs_local_video',reason:e.safe?e.message:'匿名播放器、视频传输或本机依赖无法完成校验。请检查 Chrome、playwright-core、ffprobe，或提供有权使用的本地原片。'}));
    process.exitCode=1;
  }
}
