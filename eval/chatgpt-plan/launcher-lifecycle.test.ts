import { test,expect } from 'bun:test';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'bun';
const launch=join(import.meta.dir,'launch.sh');
// Execute the actual launcher cleanup body, not a copied teardown implementation.
async function cleanupCase(stopFails:boolean,showFails=false,uidBusy=stopFails) {
 const source=await readFile(launch,'utf8'),start=source.indexOf('cleanup() {'),end=source.indexOf('\ntrap cleanup EXIT',start);
 expect(start).toBeGreaterThan(-1);expect(end).toBeGreaterThan(start);
 const root=await mkdtemp(join(tmpdir(),'s552-lifecycle-'));
 try {
  const dependency=join(import.meta.dir,'launcher-lifecycle.sh');
  const script=`[[ ! -f "$1" ]] || source "$1"
unit=s552_fixture; uid=9999; run=s552_fixture; installed=1; started=1; stub_pid=; marker="$2/pending"; marker_owned=1
printf pending > "$marker"
systemctl(){ if [[ $1 == stop ]]; then return ${stopFails?1:0}; fi; ${showFails?'return 1;':''} printf 'LoadState=loaded\\nActiveState=${stopFails?'active':'inactive'}\\nMainPID=${stopFails?42:0}\\nControlPID=0\\n'; }
pgrep(){ return ${uidBusy?0:1}; }
nft(){ if [[ $1 == delete || $1 == -f ]]; then printf 'DELETED\\n'; else printf '{"nftables":[]}'; fi; }
${source.slice(start,end)}
cleanup
`;
  const run=spawnSync(['bash','-c',script,'fixture',dependency,root],{stdout:'pipe',stderr:'pipe'});
  const marker=await Bun.file(join(root,'pending')).exists();
  return {exit:run.exitCode,marker,stdout:run.stdout.toString()};
 }finally{await rm(root,{recursive:true,force:true});}
}
test('unknown/active stop result retains containment and pending ownership',async()=>{
 const result=await cleanupCase(true);expect(result.exit).not.toBe(0);expect(result.marker).toBe(true);expect(result.stdout).toContain('HOLD');expect(result.stdout).not.toContain('DELETED');
});
test('confirmed inactive/empty process state permits cleanup and ownership release',async()=>{
 const result=await cleanupCase(false);expect(result.exit).toBe(0);expect(result.marker).toBe(false);
});
test('unavailable service readback or surviving UID processes retain containment',async()=>{
 for(const result of [await cleanupCase(false,true),await cleanupCase(false,false,true)]){
  expect(result.exit).not.toBe(0);expect(result.marker).toBe(true);expect(result.stdout).not.toContain('DELETED');
 }
});
test('launcher rules attach an independent output base chain rather than appending behind accepts',()=>{
 const run=spawnSync(['bash',launch,'print-rules','9999','1.1.1.1','s552_fixture'],{stdout:'pipe',stderr:'pipe'});
 expect(run.exitCode).toBe(0);const text=run.stdout.toString();
 expect(text).toContain('type filter hook output priority -10; policy accept;');
 expect(text).toContain('s552_fixture_gate meta skuid 9999 jump s552_fixture');
 expect(text).not.toContain('add rule inet filter output ');
});
test('real flock blocks a concurrent launcher before staging and keeps its inode',async()=>{
 const root=await mkdtemp(join(tmpdir(),'s552-lock-')),helper=join(import.meta.dir,'launcher-lifecycle.sh');
 const holder=Bun.spawn(['bash','-ec','source "$1"; acquire_owner "$2/lock" "$2/pending"; printf pending > "$2/pending"; printf ready > "$2/ready"; read -r release; rm "$2/pending"','fixture',helper,root],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
 try {
  const until=Date.now()+2000;while(!await Bun.file(join(root,'ready')).exists()&&Date.now()<until)await Bun.sleep(10);
  expect(await Bun.file(join(root,'ready')).exists()).toBe(true);
  const inode=(await Bun.file(join(root,'lock')).stat()).ino;
  const contender=spawnSync(['bash','-ec','source "$1"; acquire_owner "$2/lock" "$2/pending"; printf STAGING','fixture',helper,root],{stdout:'pipe',stderr:'pipe'});
  expect(contender.exitCode).not.toBe(0);expect(contender.stdout.toString()).not.toContain('STAGING');
  holder.stdin.write('release\n');holder.stdin.end();expect(await holder.exited).toBe(0);
  const next=spawnSync(['bash','-ec','source "$1"; acquire_owner "$2/lock" "$2/pending"; printf STAGING','fixture',helper,root],{stdout:'pipe',stderr:'pipe'});
  expect(next.exitCode).toBe(0);expect(next.stdout.toString()).toBe('STAGING');expect((await Bun.file(join(root,'lock')).stat()).ino).toBe(inode);
  await Bun.write(join(root,'pending'),'unknown prior stop');
  const pending=spawnSync(['bash','-ec','source "$1"; acquire_owner "$2/lock" "$2/pending"; printf STAGING','fixture',helper,root],{stdout:'pipe',stderr:'pipe'});
  expect(pending.exitCode).not.toBe(0);expect(pending.stdout.toString()).not.toContain('STAGING');
 }finally{holder.kill();await holder.exited;await rm(root,{recursive:true,force:true});}
});
