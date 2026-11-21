// Runs only against an isolated loopback platform fixture started by platforms.ps1.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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
async function checkPoolDiscovery() {
  const sources = await api('/datasources');
  const demo = sources.filter(source => source.name === 'jdbc/JerryDemo');
  assert.equal(demo.length, 2, 'Both the global pool and its ResourceLink must be listed');
  assert.equal((await request('/fixture/api')).status, 200);
  const summary = await until(() => api('/summary'), value => demo.every(source =>
    value.poolMetrics?.some(pool => pool.id === source.id && pool.max === 12)));
  const mirrors = demo.map(source => summary.poolMetrics.find(pool => pool.id === source.id));
  assert.ok(mirrors[0].poolId);
  assert.equal(mirrors[0].poolId, mirrors[1].poolId, 'Aliases must share one warning identity');
  console.log('PASS Pool collection before any Jerry lookup, including its ResourceLink');
}

async function checkIndependentSqlOpens(sources, healthy) {
  const single = sources.find(source => source.name === 'jdbc/JerrySingle');
  assert.ok(single?.pool?.max === 1);
  const held = await api('/sql', {source: single.id});
  let waiting = true;
  const queued = api('/sql', {source: single.id})
    .then(session => ({session}), error => ({error}))
    .finally(() => { waiting = false; });
  const close = id => request(`/jerry/api/sql/${id}`, {method: 'DELETE', json: {}});
  try {
    await until(() => api(`/datasources/${single.id}`), pool => pool.waiting > 0, 5000);
    const independent = await api('/sql', {source: healthy.id});
    try {
      assert.equal(independent.autoCommit, false);
      assert.ok(waiting, 'An unrelated JDBC pool must open while the first one waits');
    } finally {
      assert.equal((await close(independent.id)).status, 200);
    }
  } finally {
    await close(held.id);
    const result = await queued;
    if (result.session) await close(result.session.id);
    else throw result.error;
  }
  console.log('PASS Independent SQL open while another pool is exhausted');
}

async function checkLogFollow() {
  const logDir = process.env.JERRY_TEST_LOG_DIR;
  if (!logDir) return;
  const name = `tail-${crypto.randomUUID()}.log`;
  const file = path.join(logDir, name);
  await fs.writeFile(file, 'Begin\nGrü');
  try {
    const row = (await api('/logs')).find(log => log.name === name);
    assert.ok(row, 'The fixture log must be visible');
    const endpoint = `/logs/${row.id}`;
    const preview = await api(endpoint);
    assert.equal(preview.followCursor, Buffer.byteLength('Begin\n'));
    const follow = `${endpoint}?follow=true&cursor=${preview.followCursor}&identity=${encodeURIComponent(preview.identity)}`;
    const waiting = await api(follow);
    assert.deepEqual(waiting.lines, []);
    assert.equal(waiting.next, preview.followCursor);
    await fs.appendFile(file, 'ße\n');
    const complete = await api(follow);
    assert.deepEqual(complete.lines.map(line => line.text), ['Grüße']);
  } finally {
    await fs.unlink(file);
  }
  console.log('PASS Live log waits for a complete line');
}

async function checkPlatform(server) {
  const version = process.env.JERRY_TEST_VERSION;
  assert.equal(server.server, `Apache Tomcat/${version}`);
  const family = version.split('.').slice(0, 2).join('.');
  const java = {'8.5': '8', '9.0': '8', '10.0': '8', '10.1': '11', '11.0': '17'};
  assert.equal(/^(?:1\.)?(\d+)/.exec(server.java)?.[1], java[family]);
  if (family !== '11.0') return;

  const webapp = process.env.JERRY_TEST_WEBAPP_DIR;
  const manifest = await fs.readFile(path.join(webapp, 'META-INF/MANIFEST.MF'), 'utf8');
  assert.match(manifest, /^Jerry-Target-Tomcat: 11\.0\r?$/m);
  assert.match(manifest, /^Jerry-Build: native\r?$/m);
  const servlet = await fs.readFile(path.join(webapp, 'WEB-INF/classes/de/mucumba/jerry/web/JerryServlet.class'));
  assert.equal(servlet.readUInt16BE(6), 61, 'The native servlet must target Java 17');
  assert.ok(servlet.includes('jakarta/servlet/http/HttpServlet'));
  const libraries = await fs.readdir(path.join(webapp, 'WEB-INF/lib'));
  assert.ok(libraries.every(name => !/^(tomcat-|jerry-tomcat85-|.*servlet-api-)/.test(name)));
  const descriptor = await fs.readFile(path.join(webapp, 'WEB-INF/web.xml'), 'utf8');
  assert.match(descriptor, /xmlns="https:\/\/jakarta\.ee\/xml\/ns\/jakartaee" version="6\.1"/);
  console.log('PASS Native Tomcat 11 WAR uses Java 17 bytecode and the Jakarta Servlet 6.1 descriptor');
}

async function main(){
  await request('/jerry/');const login=await request('/jerry/j_security_check',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({j_username:'platform-admin',j_password:password})});assert.equal(login.status,303);
  const me=await api('/me');csrf=me.csrf;assert.equal(me.version,process.env.JERRY_PROJECT_VERSION || require('../../frontend/package.json').version);
  await checkPlatform(me.server);
  await checkPoolDiscovery();
  const apps=await api('/applications'), fixture=apps.find(a=>a.path==='/fixture');assert.ok(fixture?.running);const endpoint=`/applications/${fixture.id}/monitoring`;
  const jsp=await api(`/applications/${fixture.id}/jsps?path=${encodeURIComponent('/index.jsp')}`);
  assert.match(jsp.source,/Jerry fixture JSP/,'A registered JSP must remain readable');
  const compiled = await api(`/applications/${fixture.id}/jsps`, {paths: ['/index.jsp']});
  assert.equal(compiled[0].state, 'COMPILED', JSON.stringify(compiled));
  for (const scope of ['global', fixture.id]) {
    for (const name of ['ldap://127.0.0.1:1/evil', 'jdbc/../evil']) {
      const forged=Buffer.from(`${scope}\n${name}`).toString('base64url');
      assert.equal((await request(`/jerry/api/datasources/${forged}`)).status,400,'Unregistered JNDI names must be rejected');
    }
  }
  for (const path of ['/../WEB-INF/web.xml','/WEB-INF/web.xml','/views/../../WEB-INF/web.xml']) {
    assert.equal((await request(`/jerry/api/applications/${fixture.id}/jsps?path=${encodeURIComponent(path)}`)).status,400,'Only listed JSP files may be read');
  }
  const sources=await api('/datasources?metrics=true'), source=sources.find(s=>s.name==='jdbc/JerryDemo');assert.ok(source?.pool?.max===12,JSON.stringify(sources));
  const matching=sources.filter(s=>s.name==='jdbc/JerryDemo');
  assert.ok(matching.length>=2,'Both the global resource and the application ResourceLink must be listed');
  for (const candidate of matching) assert.ok(await api(`/datasources/${candidate.id}`));
  await checkIndependentSqlOpens(sources, source);
  await checkLogFollow();
  const session=await api('/sql',{source:source.id});assert.equal(session.autoCommit,false);
  const columns=await api(`/sql/${session.id}/metadata?schema=INFORMATION_SCHEMA&table=TABLES&columnsOnly=true`);
  assert.ok(columns.columns.some(column=>column.COLUMN_NAME==='TABLE_NAME'));
  assert.ok(!('indexes' in columns));
  await api(`/sql/${session.id}/execute`,{sql:'SELECT 1',requestId:'platform_test'});
  const query=await until(()=>api(`/sql/${session.id}`),v=>v.job && !['RUNNING','QUEUED'].includes(v.job.state));assert.equal(query.job.state,'DONE');
  if (process.env.JERRY_TEST_BROWSER === '1') {
    await api(`/sql/${session.id}/execute`, {sql:'CREATE TABLE TEST_CUSTOMERS (ID INT PRIMARY KEY, NAME VARCHAR(100))',requestId:'browser_fixture'});
    const seed=await until(()=>api(`/sql/${session.id}`),v=>v.job && !['RUNNING','QUEUED'].includes(v.job.state));assert.equal(seed.job.state,'DONE');
  }
  const close=await request(`/jerry/api/sql/${session.id}`,{method:'DELETE',json:{}});assert.equal(close.status,200);
  await api(endpoint,{mode:'BASIC'});assert.equal((await fetch(base+'/fixture/api')).status,200);assert.equal((await api(endpoint)).telemetry.operations.length,0);
  await api(endpoint,{mode:'EXTENDED'});await until(()=>api(endpoint),v=>v.instrumentation.bridgeReady);assert.equal((await fetch(base+'/fixture/api')).status,200);
  const extended=await until(()=>api(endpoint),v=>v.telemetry.operations.some(o=>o.operation.startsWith('SQL'))&&v.telemetry.operations.some(o=>o.operation.startsWith('HTTP_OUTBOUND')));assert.equal(extended.profile.mode,'EXTENDED');
  await api(endpoint,{mode:'DIAGNOSTIC',seconds:10});assert.equal((await fetch(base+'/fixture/api?action=error')).status,200);await until(()=>api(endpoint),v=>v.telemetry.details.some(e=>e.operation.startsWith('SQL')&&e.status===500));
  await api(endpoint,{mode:'BASIC'});const jar=await request(`/jerry/instrumentation/jerry-instrumentation-${me.version}.jar`);assert.equal(jar.status,200);assert.equal(Buffer.from(await jar.arrayBuffer()).subarray(0,2).toString(),'PK');
  console.log(`PASS Tomcat ${process.env.JERRY_TEST_VERSION} / Java ${me.server.java}: login, JSP, SQL and monitoring profiles`);
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
