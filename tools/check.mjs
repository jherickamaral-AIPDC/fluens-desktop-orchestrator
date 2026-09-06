import { readdir,readFile,lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
let modules=0,json=0;
async function walk(directory) {
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.name==='.git'||entry.name==='node_modules')continue;
    const file=path.join(directory,entry.name);
    if((await lstat(file)).isSymbolicLink())throw new Error('LINK_FORBIDDEN');
    if(entry.isDirectory()){await walk(file);continue;}
    if(/\.(?:mjs|js)$/.test(entry.name)) {
      const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
      if(result.error)throw new Error('NODE_CHECK_UNAVAILABLE');
      if(result.status!==0)throw new Error('SYNTAX_INVALID: '+path.relative(root,file));
      modules++;
    } else if(entry.name.endsWith('.json')) { JSON.parse(await readFile(file,'utf8'));json++; }
  }
}
try { await walk(root); console.log(JSON.stringify({modules,json,failed:0})); }
catch(error) { console.error(error.message);process.exitCode=1; }
