import {createHash} from 'node:crypto';
import {readFile,lstat,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'PUBLIC_SOURCE_MANIFEST.json'),'utf8'));
const actual=[];
async function walk(directory,prefix='') {
  if((await lstat(directory)).isSymbolicLink()||path.resolve(await realpath(directory))!==path.resolve(directory))throw new Error('LINK_FORBIDDEN');
  for(const item of await readdir(directory,{withFileTypes:true})) {
    if(item.name==='.git'||item.name==='node_modules')continue;
    const relative=prefix+item.name;
    const file=path.join(directory,item.name);
    if((await lstat(file)).isSymbolicLink())throw new Error('LINK_FORBIDDEN');
    if(item.isDirectory())await walk(file,relative+'/');
    else if(item.isFile()&&relative!=='PUBLIC_SOURCE_MANIFEST.json')actual.push(relative);
  }
}
await walk(root);
const expected=manifest.files.map(x=>x.path).sort();
actual.sort();
if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('MANIFEST_INVENTORY_DRIFT');
for(const item of manifest.files) {
  const bytes=await readFile(path.join(root,...item.path.split('/')));
  const hash=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==item.bytes||hash!==item.sha256)throw new Error('MANIFEST_CONTENT_DRIFT');
}
console.log(JSON.stringify({verified_files:manifest.files.length,drift:0}));
