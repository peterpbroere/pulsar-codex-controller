import { readFile as readFileDefault } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export interface ModernListener { address:string; port:number; pid:number }
export interface ModernConnection {
  url:string;
  port:number;
  pid:number;
  version:string;
  authorization:string;
  executablePath:string;
  tabFile?:string;
  hasClient?:boolean;
}
export interface DiscoveryOptions {
  readFile?:(path:string)=>Promise<Uint8Array|string>;
  fetch?:typeof fetch;
  env?:Record<string,string|undefined>;
  homeDir?:string;
}

function loopbackHostname(address:string):string|undefined {
  const host=address.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='::1')return '[::1]';
  const octets=host.split('.').map(Number);
  if(octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&octets[0]===127)return host;
  return undefined;
}

function candidateFiles(executablePath:string,env:Record<string,string|undefined>,home:string):string[] {
  const files:string[]=[];
  if(env.XDG_STATE_HOME)files.push(join(env.XDG_STATE_HOME,'opencode','service.json'));
  files.push(join(home,'.local','state','opencode','service.json'));

  let current=resolve(dirname(executablePath));
  const root=parse(current).root;
  for(;;){
    files.push(join(current,'profile','state','opencode','service.json'));
    if(current===root)break;
    const parent=dirname(current);
    if(parent===current)break;
    current=parent;
  }
  return [...new Set(files)];
}

function sameEndpoint(recordUrl:string,port:number):URL|undefined {
  try{
    const url=new URL(recordUrl);
    if(url.protocol!=='http:'||url.username||url.password||url.port!==String(port)||
        url.pathname!=='/'||url.search||url.hash)return;
    if(!loopbackHostname(url.hostname))return;
    return url;
  }catch{return;}
}

/** Finds a matching OpenCode 2.x service record and validates it with authenticated /api/info. */
export async function discoverModernConnection(
  listener:ModernListener,
  executablePath:string,
  hasClient:boolean,
  options:DiscoveryOptions={},
):Promise<ModernConnection|undefined> {
  const host=loopbackHostname(listener.address);
  if(!host||!Number.isInteger(listener.port)||listener.port<1||listener.port>65535||
      !Number.isInteger(listener.pid)||listener.pid<1)return;

  const readFile=options.readFile??(async path=>readFileDefault(path));
  const fetcher=options.fetch??fetch;
  const files=candidateFiles(executablePath,options.env??process.env,options.homeDir??homedir());
  for(const file of files){
    let record:any;
    try{record=JSON.parse(String(await readFile(file)));}catch{continue;}
    if(!record||record.pid!==listener.pid||typeof record.password!=='string'||!record.password||
        typeof record.version!=='string'||!/^2\./.test(record.version))continue;
    const url=sameEndpoint(record.url,listener.port);
    if(!url)continue;

    const authorization=`Basic ${Buffer.from(`opencode:${record.password}`,'utf8').toString('base64')}`;
    let info:any;
    try{
      const response=await fetcher(new URL('/api/info',url),{
        headers:{authorization},
        redirect:'error',
        signal:AbortSignal.timeout(4000),
      });
      if(!response.ok)continue;
      info=await response.json();
    }catch{continue;}
    if(!info||info.pid!==listener.pid||typeof info.version!=='string'||
        info.version!==record.version||!/^2\./.test(info.version))continue;

    return {
      url:url.toString().replace(/\/$/,''),port:listener.port,pid:listener.pid,
      version:info.version,authorization,executablePath,
      tabFile:join(dirname(file),'latest','tui','tabs.json'),hasClient,
    };
  }
}
