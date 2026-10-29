// Runs only against an isolated loopback platform fixture started by platforms.ps1.
const assert = require('node:assert/strict');
const port=Number(process.env.JERRY_TEST_PORT), password=process.env.JERRY_TEST_PASSWORD;
if (!Number.isInteger(port) || port < 16860 || port > 16869 || !password) throw Error('Invalid platform test environment');
const base=`http://127.0.0.1:${port}`, cookies=new Map(); let csrf='';
async function request(path, options={}) {
  const headers={Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(options.headers||{})};
  if(options.json!==undefined) {headers['Content-Type']='application/json';headers['X-CSRF-Token']=csrf;options.body=JSON.stringify(options.json);delete options.json;}
  const result=await fetch(base+path,{...options,headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
  for(const cookie of result.headers.getSetCookie()) {const entry=cookie.split(';')[0],i=entry.indexOf('=');cookies.set(entry.slice(0,i),entry.slice(i+1));}
  return result;
}
async function api(path,body) { const r=await request('/jerry/api'+path,body===undefined?{}:{method:'POST',json:body});const text=await r.text();assert.equal(r.status,200,`${path}: ${text.slice(0,300)}`);return JSON.parse(text); }
async function until(get,predicate,ms=15000){const deadline=Date.now()+ms;let v;do{v=await get();if(predicate(v))return v;await new Promise(r=>setTimeout(r,250));}while(Date.now()<deadline);throw Error('Timed out: '+JSON.stringify(v).slice(0,600));}
async function main(){
  await request('/jerry/');const login=await request('/jerry/j_security_check',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({j_username:'platform-admin',j_password:password})});assert.equal(login.status,303);
  const me=await api('/me');csrf=me.csrf;assert.equal(me.version,'2.0.0');assert.match(me.server.server,new RegExp('Apache Tomcat/'+process.env.JERRY_TEST_VERSION.replaceAll('.','\\.')));
  const apps=await api('/applications'), fixture=apps.find(a=>a.path==='/fixture');assert.ok(fixture?.running);const endpoint=`/applications/${fixture.id}/monitoring`;
  const sources=await api('/datasources?metrics=true'), source=sources.find(s=>s.name==='jdbc/JerryDemo');assert.ok(source?.pool?.max===12,JSON.stringify(sources));
  const session=await api('/sql',{source:source.id});assert.equal(session.autoCommit,false);
  await api(`/sql/${session.id}/execute`,{sql:'SELECT 1',requestId:'platform_test'});
  const query=await until(()=>api(`/sql/${session.id}`),v=>v.job && !['RUNNING','QUEUED'].includes(v.job.state));assert.equal(query.job.state,'DONE');
  const close=await request(`/jerry/api/sql/${session.id}`,{method:'DELETE',json:{}});assert.equal(close.status,200);
  await api(endpoint,{mode:'BASIC'});assert.equal((await fetch(base+'/fixture/api')).status,200);assert.equal((await api(endpoint)).telemetry.operations.length,0);
  await api(endpoint,{mode:'EXTENDED'});await until(()=>api(endpoint),v=>v.instrumentation.bridgeReady);assert.equal((await fetch(base+'/fixture/api')).status,200);
  const extended=await until(()=>api(endpoint),v=>v.telemetry.operations.some(o=>o.operation.startsWith('SQL'))&&v.telemetry.operations.some(o=>o.operation.startsWith('HTTP_OUTBOUND')));assert.equal(extended.profile.mode,'EXTENDED');
  await api(endpoint,{mode:'DIAGNOSTIC',seconds:10});assert.equal((await fetch(base+'/fixture/api?action=error')).status,200);await until(()=>api(endpoint),v=>v.telemetry.details.some(e=>e.operation.startsWith('SQL')&&e.status===500));
  await api(endpoint,{mode:'BASIC'});const jar=await request('/jerry/instrumentation/jerry-instrumentation-2.0.0.jar');assert.equal(jar.status,200);assert.equal(Buffer.from(await jar.arrayBuffer()).subarray(0,2).toString(),'PK');
  console.log(`PASS Tomcat ${process.env.JERRY_TEST_VERSION}: login, pool, SQL, profiles and adapter`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
