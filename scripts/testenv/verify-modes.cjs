const { Client, base, environment, access, delay } = require('./verify.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const report = { started: new Date().toISOString(), warSha256: environment.warSha256, checks: [] };
async function check(name, action) {
  const start = Date.now();
  try { const detail = await action(); report.checks.push({ name, state:'PASS', ms:Date.now()-start, detail }); console.log('PASS '+name); }
  catch(error) { report.checks.push({ name, state:'FAIL', error:error.message }); throw error; }
}
async function until(read, predicate, timeout=20000) {
  const start=Date.now(); let value;
  do { value=await read(); if(predicate(value)) return value; await delay(250); } while(Date.now()-start<timeout);
  assert.fail('Timed out: '+JSON.stringify(value));
}
async function main() {
  const admin=new Client(); await admin.login(access.user,access.password);
  const apps=await admin.api('/applications'), demo=apps.find(app=>app.path==='/jerry-demo'), framework=apps.find(app=>app.path==='/jerry-framework'), self=apps.find(app=>app.self);
  assert.ok(demo?.running && framework?.running && self?.running,JSON.stringify(apps));
  const endpoint=app=>`/applications/${app.id}/monitoring`, get=()=>admin.api(endpoint(framework));
  if(process.argv[2]==='prepare-restart') {
    await admin.post(endpoint(demo),{mode:'EXTENDED'});
    await admin.post(endpoint(framework),{mode:'BASIC'});
    await admin.post(endpoint(framework),{mode:'DIAGNOSTIC',seconds:60});
    console.log('Restart prepared: extended demo, temporary framework diagnosis'); return;
  }
  if(process.argv[2]==='check-restart') {
    await check('Extended survives restart; diagnostic lease does not',async()=>{
      assert.equal((await admin.api(endpoint(demo))).profile.mode,'EXTENDED');
      assert.equal((await get()).profile.mode,'BASIC');
    });
    await admin.post(endpoint(demo),{mode:'BASIC'}); await admin.post(endpoint(framework),{mode:'EXTENDED'});
  } else try {
    for(const app of [demo,framework,self]) await admin.post(endpoint(app),{mode:'BASIC'});
    await check('BASIC default gates per-application counters and detail events',async()=>{
      await fetch(base+'/jerry-framework/api'); const value=await get();
      assert.equal(value.profile.mode,'BASIC'); assert.equal(value.profile.baseline,'BASIC');
      assert.equal(value.telemetry.operations.length,0); assert.equal(value.telemetry.details.length,0); assert.equal(value.collection.components,null);
      assert.equal((await admin.api('/applications')).find(app=>app.id===demo.id).monitoring.mode,'BASIC');
    });
    await check('Mode changes require admin and CSRF; invalid modes/durations rejected',async()=>{
      const viewer=new Client(); await viewer.login(access.viewer,access.viewerPassword);
      await viewer.post(endpoint(framework),{mode:'EXTENDED'},403);
      await viewer.api(endpoint(framework),{},403);
      await admin.api(endpoint(framework),{method:'POST',json:{mode:'EXTENDED'},noCsrf:true},403);
      for(const body of [{mode:'NONE'},{mode:'DIAGNOSTIC',seconds:0},{mode:'DIAGNOSTIC',seconds:901},{mode:'DIAGNOSTIC',seconds:10.5},{mode:'DIAGNOSTIC',seconds:'10'}]) await admin.post(endpoint(framework),body,400);
      await admin.post('/applications/unknown/monitoring',{mode:'EXTENDED'},400);
      assert.equal((await get()).profile.mode,'BASIC');
    });
    await check('EXTENDED captures servlet timings and real Spring/Quartz/JMS-client/executor state',async()=>{
      await admin.post(endpoint(framework),{mode:'EXTENDED'});
      for(let i=0;i<8;i++) await fetch(base+'/jerry-framework/api');
      const value=await until(get,v=>v.collection.components?.quartz.length && v.telemetry.jobs.length>=5,25000);
      assert.ok(value.telemetry.operations.find(row=>row.operation.includes('HTTP') && row.calls>=8));
      assert.ok(value.telemetry.operations.some(row=>row.operation.includes('QUARTZ') && row.errors>0));
      assert.equal(value.telemetry.details.length,0);
      const components=value.collection.components;
      assert.equal(components.spring.length,1); assert.equal(components.quartz[0].name,'JerryFixtureScheduler');
      assert.equal(components.jms[0].destination,'jerry.fixture.client-only'); assert.equal(components.jms[0].running,false); assert.equal(components.jms[0].minConsumers,2); assert.equal(components.jms[0].maxConsumers,4);
      assert.equal(components.executors[0].max,3);
      assert.equal((await (await fetch(base+'/jerry-framework/api')).json()).lazyConstructed,0);
      assert.equal((await admin.api(endpoint(demo))).profile.mode,'BASIC');
      return { components, operations:value.telemetry.operations, jobs:value.telemetry.jobs.length };
    });
    await check('DIAGNOSTIC records bounded metadata, polling does not renew, expiry restores EXTENDED',async()=>{
      const started=await admin.post(endpoint(framework),{mode:'DIAGNOSTIC',seconds:10}), expires=started.profile.expiresAt;
      assert.equal(started.profile.baseline,'EXTENDED');
      assert.equal((await fetch(base+'/jerry-framework/api?action=error&secret=must-not-be-recorded')).status,500);
      const value=await until(get,v=>v.telemetry.details.length>0,5000);
      assert.equal(value.profile.expiresAt,expires); assert.ok(!JSON.stringify(value.telemetry).includes('secret'));
      assert.ok(value.telemetry.details.some(event=>event.status===500 && event.operation.includes('HTTP')));
      const expired=await until(get,v=>v.profile.mode==='EXTENDED',13000);
      assert.equal(expired.profile.expiresAt,null); assert.equal(expired.telemetry.details.length,0);
    });
    await check('Global diagnostic concurrency limit and manual return to BASIC',async()=>{
      await admin.post(endpoint(framework),{mode:'BASIC'});
      await admin.post(endpoint(framework),{mode:'DIAGNOSTIC',seconds:10});
      await admin.post(endpoint(demo),{mode:'DIAGNOSTIC',seconds:10});
      await admin.post(endpoint(self),{mode:'DIAGNOSTIC',seconds:10},409);
      const stopped=await admin.post(endpoint(framework),{action:'stop'});
      assert.equal(stopped.profile.mode,'BASIC'); assert.equal(stopped.telemetry.operations.length,0);
      await admin.post(endpoint(demo),{action:'stop'});
      await admin.post(endpoint(framework),{mode:'DIAGNOSTIC',seconds:10});
      const expired=await until(get,v=>v.profile.mode==='BASIC',13000); assert.equal(expired.telemetry.details.length,0);
    });
    await check('All modes serve concurrent requests without telemetry failures',async()=>{
      const timings=[];
      for(const mode of ['BASIC','EXTENDED','DIAGNOSTIC']) {
        await admin.post(endpoint(framework),{mode,seconds:60}); const start=performance.now();
        await Promise.all(Array.from({length:8},async()=>{for(let i=0;i<25;i++) {const response=await fetch(base+'/jerry-framework/api'); assert.equal(response.status,200); await response.arrayBuffer();}}));
        const value=await get();
        if(mode==='BASIC') assert.equal(value.telemetry.operations.length,0);
        else assert.equal(value.telemetry.operations.find(row=>row.operation.startsWith('HTTP')).calls,200);
        timings.push({mode,requests:200,concurrency:8,elapsedMs:Math.round(performance.now()-start)});
      }
      await admin.post(endpoint(framework),{mode:'BASIC'}); return {note:'Functional load smoke test; not a production overhead benchmark',timings};
    });
    await check('Repeated toggles do not duplicate Quartz listeners; bounded collectors and light thread polling',async()=>{
      for(let i=0;i<2;i++) { await admin.post(endpoint(framework),{mode:'EXTENDED'}); await delay(11000); await admin.post(endpoint(framework),{mode:'BASIC'}); }
      await admin.post(endpoint(framework),{mode:'EXTENDED'});
      await until(get,v=>v.collection.components?.quartz.length,15000);
      const before=(await get()).telemetry.operations.find(row=>row.operation.startsWith('QUARTZ ·'))?.calls || 0;
      await delay(3500); const value=await get(), after=value.telemetry.operations.find(row=>row.operation.startsWith('QUARTZ ·'))?.calls || 0;
      assert.ok(after-before>=2 && after-before<=5,`${before}->${after}`);
      const diagnostics=await admin.api('/diagnostics'); assert.equal(diagnostics.applicationCollectors.workers,2); assert.ok(diagnostics.applicationCollectors.queued<=16); assert.ok(diagnostics.telemetry.queued<=256);
      const threads=await admin.api('/threads'); assert.ok(threads.every(thread=>!thread.stack?.length));
      assert.ok((await admin.api('/threads?stacks=true')).some(thread=>thread.stack?.length));
      assert.equal((await (await fetch(base+'/jerry-framework/api')).json()).lazyConstructed,0);
      return diagnostics;
    });
  } finally {
    await admin.post(endpoint(demo),{mode:'BASIC'}); await admin.post(endpoint(self),{mode:'BASIC'}); await admin.post(endpoint(framework),{mode:'BASIC'});
  }
}
main().catch(error=>{if(!report.checks.some(row=>row.state==='FAIL'))report.checks.push({name:'Runner prerequisites',state:'FAIL',error:error.message});console.error(error.stack); process.exitCode=1;}).finally(()=>{
  report.finished=new Date().toISOString(); report.passed=report.checks.filter(row=>row.state==='PASS').length; report.failed=report.checks.filter(row=>row.state==='FAIL').length;
  const name=process.argv[2]==='check-restart'?'modes-restart-report.json':'modes-report.json';
  if(process.argv[2]!=='prepare-restart') fs.writeFileSync(path.resolve(__dirname,'../../.tools/jerry-testenv',name),JSON.stringify(report,null,2));
});
