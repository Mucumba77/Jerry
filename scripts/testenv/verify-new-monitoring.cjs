const { Client, base, environment, access, delay } = require('./verify.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const report = { started:new Date().toISOString(), warSha256:environment.warSha256, checks:[] };
async function check(name, action) { const start=Date.now(); try { const detail=await action(); report.checks.push({name,state:'PASS',ms:Date.now()-start,detail}); console.log('PASS '+name); } catch(e) { report.checks.push({name,state:'FAIL',error:e.message}); console.error('FAIL '+name+': '+e.message); throw e; } }
async function until(read, predicate, timeout=30000) { const start=Date.now(); let value; do { value=await read();if(predicate(value))return value;await delay(300); }while(Date.now()-start<timeout);throw new Error('Timed out: '+JSON.stringify(value).slice(0,1500)); }
async function main() {
  const admin=new Client(), viewer=new Client(); await admin.login(access.user,access.password); await viewer.login(access.viewer,access.viewerPassword);
  const original=(await admin.api('/alerts')).settings;
  const framework=(await admin.api('/applications')).find(a=>a.path==='/jerry-framework'); assert.ok(framework?.running);
  const endpoint=`/applications/${framework.id}/monitoring`, get=()=>admin.api(endpoint);
  const previous=(await get()).profile.baseline;
  try {
    await check('Admin and CSRF protect threshold settings, validation rejects invalid values',async()=> {
      await viewer.post('/alerts',original,403); await admin.api('/alerts',{method:'POST',json:original,noCsrf:true},403);
      await admin.post('/alerts',{...original,poolPercent:101},400);
      assert.deepEqual((await admin.api('/alerts')).settings,original);
    });
    await check('Threshold triggers and resets with real heap samples',async()=> {
      await admin.post('/alerts',{...original,heapEnabled:true,poolEnabled:false,errorEnabled:false,heapPercent:1,delaySeconds:0,recoverySeconds:0});
      const fired=await until(()=>admin.api('/summary'),v=>v.alerts?.active?.some(a=>a.kind==='Heap'));
      assert.ok(fired.alerts.active[0].value>=1);
      await admin.post('/alerts',{...original,heapEnabled:true,poolEnabled:false,errorEnabled:false,heapPercent:100,delaySeconds:0,recoverySeconds:0});
      await until(()=>admin.api('/summary'),v=>v.alerts?.active?.length===0 && v.alerts.settings.heapPercent===100);
    });
    await check('Pool metrics collected in history without borrowing connections',async()=> {
      const sources=await admin.api('/datasources?metrics=true'); const source=sources.find(s=>s.name==='jdbc/JerryDemo' && s.pool?.max===12);
      assert.ok(source,JSON.stringify(sources)); const from=Date.now();
      const summary=await until(()=>admin.api('/summary'),v=>v.poolMetrics?.some(p=>p.id===source.id && p.max===12),45000);
      assert.ok(summary.poolCollectedAt); assert.equal(summary.poolCollectorState,'READY');
      const history=await until(()=>admin.api('/history?from='+from+'&to='+Date.now()+'&points=100'),v=>v.some(p=>p.poolMetrics?.some(x=>x.id===source.id)),10000);
      const entry=history.find(p=>p.poolMetrics?.some(x=>x.id===source.id)); const pool=entry.poolMetrics.find(x=>x.id===source.id);
      assert.equal(typeof pool.active,'number'); assert.equal(typeof pool.idle,'number'); assert.ok(!('url' in pool)); return {pool};
    });
    await check('A borrowed pooled connection raises and clears one pool warning',async()=> {
      const source=(await admin.api('/datasources?metrics=true')).find(s=>s.name==='jdbc/JerryDemo' && s.pool?.max===12);
      await admin.post('/alerts',{...original,heapEnabled:false,poolEnabled:true,errorEnabled:false,poolPercent:1,delaySeconds:0,recoverySeconds:0,hysteresisPercent:0});
      const session=await admin.post('/sql',{source:source.id});
      try {
        const fired=await until(()=>admin.api('/summary'),v=>v.alerts?.active?.some(a=>a.kind==='Connection Pool'),45000);
        assert.equal(fired.alerts.active.filter(a=>a.kind==='Connection Pool').length,1);
        assert.equal(fired.alerts.active.find(a=>a.kind==='Connection Pool').source,'jdbc/JerryDemo');
      } finally { await admin.api(`/sql/${session.id}`,{method:'DELETE'}); }
      await until(()=>admin.api('/summary'),v=>!v.alerts?.active?.some(a=>a.kind==='Connection Pool'),45000);
    });
    await check('BASIC does not record instrumented calls',async()=> {
      await admin.post(endpoint,{mode:'BASIC'}); await until(get,v=>!v.instrumentation.bridgeReady);
      const response=await fetch(base+'/jerry-framework/api?action=instrument'); assert.equal(response.status,200,await response.text());
      const v=await get(); assert.equal(v.telemetry.operations.length,0);assert.equal(v.telemetry.details.length,0);
    });
    await check('EXTENDED captures real HTTP, JMS and JDBC calls without content',async()=> {
      await admin.post(endpoint,{mode:'EXTENDED'});await until(get,v=>v.instrumentation.bridgeReady);
      const response=await fetch(base+'/jerry-framework/api?action=instrument');assert.equal(response.status,200,await response.text());
      const v=await until(get,v=>['HTTP_OUTBOUND','JMS_SEND','JMS_RECEIVE','SQL'].every(k=>v.telemetry.operations.some(o=>o.operation.startsWith(k))));
      assert.ok(v.telemetry.operations.some(o=>o.operation.startsWith('SQL') && o.errors>0));
      assert.ok(v.telemetry.operations.some(o=>o.operation.startsWith('HTTP_OUTBOUND') && o.errors>0));
      assert.ok(v.telemetry.operations.some(o=>o.operation.startsWith('JMS_SEND') && o.errors>0));
      for(const secret of ['JERRY_MISSING_TEST_TABLE','fixture-private-message','127.0.0.1']) assert.ok(!JSON.stringify(v.telemetry).includes(secret));
      assert.equal(v.telemetry.details.length,0);return v.telemetry.operations;
    });
    await check('DIAGNOSTIC captures error metadata and expires to EXTENDED',async()=> {
      await admin.post(endpoint,{mode:'DIAGNOSTIC',seconds:10}); await until(get,v=>v.instrumentation.bridgeReady);
      const response=await fetch(base+'/jerry-framework/api?action=instrument'); assert.equal(response.status,200,await response.text());
      const captured=await until(get,v=>v.telemetry.details.some(e=>e.operation.startsWith('SQL')&&e.status===500),5000);
      assert.ok(captured.telemetry.details.some(e=>e.operation.startsWith('HTTP_OUTBOUND')&&e.status===500));
      assert.ok(captured.telemetry.details.some(e=>e.operation.startsWith('JMS_SEND')&&e.status===500));
      assert.ok(!JSON.stringify(captured.telemetry.details).includes('JERRY_MISSING_TEST_TABLE'));
      const expired=await until(get,v=>v.profile.mode==='EXTENDED',13000);assert.equal(expired.telemetry.details.length,0);
    });
    await check('Adapter JAR is downloadable',async()=> { const res=await admin.request('/jerry/instrumentation/jerry-instrumentation-2.0.0.jar'); assert.equal(res.status,200); const buf=Buffer.from(await res.arrayBuffer());assert.equal(buf.subarray(0,2).toString(),'PK'); });
  } finally { await admin.post('/alerts',original);await admin.post(endpoint,{mode:previous}); report.finished=new Date().toISOString(); fs.writeFileSync(path.join(__dirname,'../../.tools/jerry-testenv/new-monitoring-report.json'),JSON.stringify(report,null,2)); }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
