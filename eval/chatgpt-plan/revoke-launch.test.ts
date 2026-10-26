import { test,expect } from 'bun:test';
import { readFile,mkdtemp,rm,writeFile,stat,chown,symlink,mkdir,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'bun';
import { TokenStore } from './auth.ts';
const launch=join(import.meta.dir,'launch.sh'),helper=join(import.meta.dir,'launcher-lifecycle.sh');
const shell=(code:string,args:string[]=[])=>spawnSync(['bash','-ec',code,'fixture',...args],{stdout:'pipe',stderr:'pipe'});
async function modeRules(mode:string,evidence:string){
 const source=await readFile(launch,'utf8');
 const gate=source.slice(source.indexOf('mode=${1:-}'),source.indexOf('# This build brief'));
 const rules=source.slice(source.indexOf('rules() {'),source.indexOf('if [[ ${1:-} == print-rules'));
 return shell(`${gate}\n${rules}\nrules 9999 1.1.1.1 s552_mode "$profile"`,[mode,evidence]);
}
test('revoke is admitted and uses exactly the run evaluation rule bytes',async()=>{
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
 try{
  const evidence=join(root,'operator-evidence');await writeFile(evidence,'Synthetic account-removal receipt; not authorization.',{mode:0o600});
  const run=await modeRules('run',evidence),revoke=await modeRules('revoke',evidence);
  expect(run.exitCode).toBe(0);expect(revoke.exitCode).toBe(0);expect(revoke.stdout.equals(run.stdout)).toBe(true);
  expect(revoke.stdout.toString()).not.toContain('ct state established');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('missing evidence is refused before acquiring ownership or staging',()=>{
 const result=spawnSync(['bash',launch,'revoke'],{stdout:'pipe',stderr:'pipe'});
 expect(result.exitCode).toBe(2);expect(result.stderr.toString()).toContain('evidence-file');expect(result.stdout.length).toBe(0);
});
test('unknown mode, empty evidence and extra arguments are refused before staging',async()=>{
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
 try{
  const empty=join(root,'empty');await writeFile(empty,'',{mode:0o600});
  for(const args of [['unknown'],['revoke',empty],['revoke',empty,'extra'],['revoke',launch]]){
   const result=spawnSync(['bash',launch,...args],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode).toBe(2);expect(result.stdout.length).toBe(0);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
test('revocation evidence staging creates a real owner-only file without broadening source access',async()=>{
 expect(process.getuid!()).toBe(0);
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
 try{
  const input=join(root,'evidence'),output=join(root,'staged');await writeFile(input,'Synthetic evidence only.',{mode:0o600});
  const result=shell('source "$1"; stage_revoke_evidence "$2" "$3" 65534 65534',[helper,input,output]);
  expect(result.exitCode).toBe(0);const st=await stat(output);expect(st.uid).toBe(65534);expect(st.gid).toBe(65534);expect(st.mode&0o777).toBe(0o600);
  expect(await readFile(output,'utf8')).toBe(await readFile(input,'utf8'));expect((await stat(input)).mode&0o777).toBe(0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('actual revoke dispatch uses only run preflight then confined revoke and stdout is JSON only',async()=>{
 const source=await readFile(launch,'utf8'),start=source.lastIndexOf('if [[ $mode == rehearse* ]]; then');
 expect(start).toBeGreaterThan(-1);
 expect(source).toContain('stage_revoke_evidence "$evidence" "$root/out/revoke-evidence" "$uid" "$(id -g gbrain-eval)"');
 expect(source).toContain('exec 3>&1 1>&2');
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
 try{
  const result=shell(`mode=revoke; root="$1"; run=s552_fixture; exec 3>&1 1>&2
inside(){ printf '%s\\n' "$*" >> "$root/trace"; if [[ $1 == revoke ]]; then printf '{"renewable_session":"revoked","access_token":"rejected","local_credentials":"absent"}\\n'; fi; }
nft(){ printf '{"nftables":[{"rule":{"expr":[{"counter":{"packets":1}}]}}]}'; }
${source.slice(start)}`,[root]);
  expect(result.exitCode).toBe(0);expect((await readFile(join(root,'trace'),'utf8')).split('\n').filter(Boolean)).toEqual(['probe',`revoke ${root}/out/revoke-evidence`]);
  expect(JSON.parse(result.stdout.toString())).toEqual({renewable_session:'revoked',access_token:'rejected',local_credentials:'absent'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unknown revoke retains pending ownership after confirmed cessation, success releases it',async()=>{
 const source=await readFile(launch,'utf8'),start=source.indexOf('cleanup() {'),end=source.indexOf('\ntrap cleanup EXIT',start);
 for(const code of [1,0]){
  const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
  try{
   await writeFile(join(root,'pending'),'synthetic pending');
   const result=shell(`mode=revoke; unit=s552_fixture; uid=65534; run=s552_fixture; installed=0; started=1; stub_pid=; marker_owned=1; marker="$1/pending"
stop_confirmed(){ return 0; }
nft(){ printf '{"nftables":[]}'; }
${source.slice(start,end)}
trap cleanup EXIT
exit ${code}`,[root]);
   expect(result.exitCode).toBe(code);expect(await Bun.file(join(root,'pending')).exists()).toBe(code!==0);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});
test('root-direct CLI revoke fails token-store ownership before creating a lock or making requests',async()=>{
 expect(process.getuid!()).toBe(0);
 const root=await mkdtemp(join(process.env.TMPDIR!,'s552-revoke-'));
 try{
  const auth=join(root,'auth');await mkdir(auth,{mode:0o700});await chown(auth,65534,65534);
  await expect(new TokenStore(auth).prepare()).rejects.toThrow('AUTH-MODE');
  // Only the fixed ROOT constant is remapped; all CLI logic/dependencies are the actual source.
  const original=await readFile(join(import.meta.dir,'cli.ts'),'utf8'),needle="const ROOT='/srv/gbrain-eval';";
  expect(original.split(needle).length).toBe(2);
  await writeFile(join(root,'cli.ts'),original.replace(needle,`const ROOT=${JSON.stringify(root)};`));
  for(const name of ['auth.ts','adapter.ts','harness.ts'])await symlink(join(import.meta.dir,name),join(root,name));
  await symlink(join(import.meta.dir,'../../node_modules'),join(root,'node_modules'),'dir');
  const evidence=join(root,'evidence');await writeFile(evidence,'Synthetic account-removal fixture, not authorization.',{mode:0o600});
  const result=spawnSync([process.execPath,join(root,'cli.ts'),'revoke',evidence],{stdout:'pipe',stderr:'pipe'});
  expect(result.exitCode).toBe(1);expect(result.stdout.length).toBe(0);expect(result.stderr.toString().trim()).toBe('S552 stopped; no retry. Inspect protected evidence locally.');
  expect(await readdir(auth)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
