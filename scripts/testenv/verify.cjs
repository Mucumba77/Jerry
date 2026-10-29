// Integration checks against the disposable, loopback-only Tomcat test instance.
// No production endpoints or credentials are accepted by this runner.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const testRoot = process.env.JERRY_TEST_ENV_ROOT || path.join(root, '.tools/jerry-testenv');
const environment = JSON.parse(fs.readFileSync(path.join(testRoot, 'environment.json'), 'utf8').replace(/^\uFEFF/, ''));
const access = JSON.parse(fs.readFileSync(path.join(testRoot, 'access.json'), 'utf8').replace(/^\uFEFF/, ''));
const base = `http://127.0.0.1:${environment.port}`;
const report = { started: new Date().toISOString(), environment: {url: environment.url, warSha256: environment.warSha256}, checks: [] };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
class Client {
  cookies = new Map();
  csrf = '';
  async request(route, options = {}) {
    const headers = { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers };
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    if (options.method && options.method !== 'GET' && !options.noCsrf) headers['X-CSRF-Token'] = this.csrf;
    const response = await fetch(base + route, {...options, headers, redirect: 'manual', signal: options.signal || AbortSignal.timeout(30000)});
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const boundary = pair.indexOf('=');
      this.cookies.set(pair.slice(0, boundary), pair.slice(boundary + 1));
    }
    return response;
  }
  async api(route, options = {}, expected = 200) {
    const response = await this.request('/jerry/api' + route, options);
    const text = await response.text();
    assert.equal(response.status, expected, `${options.method || 'GET'} ${route}: ${text.slice(0, 600)}`);
    return text ? JSON.parse(text) : null;
  }
  async login(user, password) {
    await this.request('/jerry/');
    const response = await this.request('/jerry/j_security_check', {method:'POST', noCsrf:true, headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({j_username:user, j_password:password})});
    assert.equal(response.status, 303, 'FORM login redirects after authentication');
    await this.request('/jerry/');
    const me = await this.api('/me');
    this.csrf = me.csrf;
    assert.equal(me.user, user);
    return me;
  }
  post(route, json = {}, expected = 200) { return this.api(route, {method:'POST', json}, expected); }
}
async function check(name, action) {
  const start = Date.now();
  try {
    const detail = await action();
    report.checks.push({name, state:'PASS', ms:Date.now()-start, ...(detail ? {detail} : {})});
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({name, state:'FAIL', ms:Date.now()-start, error:error.message});
    console.error(`FAIL ${name}: ${error.message}`);
    throw error;
  }
}
async function execute(client, id, sql, requestId = 'test_' + crypto.randomUUID()) {
  await client.post(`/sql/${id}/execute`, {sql, requestId});
  for (let attempt=0; attempt<200; attempt++) {
    const status = await client.api(`/sql/${id}`);
    if (!['RUNNING','QUEUED'].includes(status.job.state)) return status;
    await delay(50);
  }
  throw new Error('SQL job timeout');
}
function result(status, index=0) {
  assert.equal(status.job.state, 'DONE', JSON.stringify(status.job));
  return status.job.steps[index].results.find(output => output.type === 'rows').result;
}
async function main() {
  const admin = new Client(), viewer = new Client(), reader = new Client(), other = new Client();
  const sqlSessions = [];
  let upload;
  try {
    await check('Anonymous API access rejected', async () => {
      await new Client().api('/me', {}, 401);
    });
    await check('Login font and local styles load without authentication', async () => {
      const anonymous = new Client();
      for (const route of ['/jerry/login.css','/jerry/fonts.css','/jerry/fonts/OFL.txt']) {
        const response = await anonymous.request(route);
        assert.equal(response.status,200,route);
        const content = await response.text();
        assert.ok(content.length>100);
        if (route.endsWith('login.css')) assert.match(content, /#182932/);
      }
      const font = await anonymous.request('/jerry/fonts/Onest-Variable.ttf');
      assert.equal(font.status,200);
      assert.match(font.headers.get('content-type'), /font\/ttf/);
      const bytes=Buffer.from(await font.arrayBuffer());
      assert.equal(bytes.subarray(0,4).toString('hex'),'00010000');
      assert.ok(bytes.length>100000);
    });
    await check('Tomcat FORM authentication and exact target platform', async () => {
      const me = await admin.login(access.user, access.password);
      assert.match(JSON.stringify(me.server), /Apache Tomcat\/8\.5\.100/);
      assert.match(JSON.stringify(me.server), /1\.8\./);
      const entry = await admin.request('/jerry/');
      assert.match(entry.headers.get('cache-control'), /no-store/);
      return me.server;
    });
    await viewer.login(access.viewer, access.viewerPassword);
    await reader.login(access.reader, access.readerPassword);
    await other.login(access.user, access.password);
    await check('Missing CSRF rejected', async () => {
      await admin.api('/quickcheck', {method:'POST', json:{}, noCsrf:true}, 403);
    });
    await check('Viewer denied privileged and SQL actions', async () => {
      await viewer.post('/gc', {}, 403);
      await viewer.api('/certificates', {}, 403);
      await viewer.post('/sql', {source:'anything'}, 403);
      await viewer.post('/deployments', {}, 403);
    });
    for (const endpoint of ['summary','applications','datasources','connectors','processors','threads','logs','cluster','system','certificates','wrapper','diagnostics','history']) {
      await check(`Live API /${endpoint}`, async () => {
        const value = await admin.api('/'+endpoint);
        assert.ok(value && typeof value === 'object');
        if (endpoint==='diagnostics') assert.equal(value.collectionError, null);
      });
    }
    await check('SSE delivers a live snapshot', async () => {
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 8000);
      try {
        const response = await admin.request('/jerry/api/events', {signal:abort.signal});
        assert.equal(response.status,200);
        assert.match(response.headers.get('content-type'), /text\/event-stream/);
        const stream = response.body.getReader();
        let text = '';
        while (!text.includes('\n\n')) {
          const value = await stream.read();
          assert.equal(value.done,false);
          text += new TextDecoder().decode(value.value);
        }
        assert.match(text,/event: snapshot/);
        const snapshot = JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6));
        assert.ok(snapshot.time);
      } finally { clearTimeout(timeout); abort.abort(); }
    });
    const fixtureResponse = await fetch(base+'/jerry-demo/api?action=error');
    assert.equal(fixtureResponse.status,200);
    const applications = await admin.api('/applications');
    const fixture = applications.find(app=>app.path==='/jerry-demo');
    assert.ok(fixture?.running);
    await check('Application details, JSP sources, live sessions and attribute removal', async () => {
      const details = await admin.api(`/applications/${fixture.id}`);
      assert.ok(details);
      const jsps = await admin.api(`/applications/${fixture.id}/jsps`);
      assert.match(JSON.stringify(jsps),/index\.jsp/);
      const source = await admin.api(`/applications/${fixture.id}/jsps?path=%2Findex.jsp`);
      assert.match(source.source,/Grüße aus Köln/);
      const sessions = await admin.api(`/applications/${fixture.id}/sessions`);
      assert.ok(sessions.length);
      const session = sessions.find(session=>session.attributes?.length) || sessions[0];
      await admin.post(`/applications/${fixture.id}/sessions`, {action:'remove-attribute', ids:[session.id], attribute:'visitor'});
      const detail = await admin.api(`/applications/${fixture.id}/sessions?session=${encodeURIComponent(session.id)}`);
      assert.ok(!JSON.stringify(detail).includes('Jerry Test – Grüße aus Köln'));
      await admin.post(`/applications/${fixture.id}/sessions`, {action:'expire', ids:[session.id]});
      const remaining = await admin.api(`/applications/${fixture.id}/sessions`);
      assert.ok(!remaining.some(value=>value.id===session.id));
    });
    const sources = await admin.api('/datasources');
    const source = sources.find(source=>source.application==='Global' && source.name==='jdbc/JerryDemo');
    assert.ok(source, JSON.stringify(sources));
    await check('Global JNDI DataSource and actual connection pool', async () => {
      const pool = await admin.api(`/datasources/${source.id}`);
      assert.match(JSON.stringify(pool), /tomcat\.jdbc|DataSource/);
      assert.equal(typeof pool.active, 'number');
      assert.equal(typeof pool.idle, 'number');
      assert.equal(pool.max, 12);
      await admin.post(`/datasources/${source.id}`, {action:'test'});
    });
    const workspace = await admin.post('/sql',{source:source.id});
    sqlSessions.push([admin,workspace.id]);
    const observer = await admin.post('/sql',{source:source.id});
    sqlSessions.push([admin,observer.id]);
    await check('Pool snapshots show occupied, idle and maximum connections', async () => {
      const snapshots = await viewer.api('/datasources?metrics=true');
      const snapshot = snapshots.find(row=>row.id===source.id);
      assert.ok(snapshot.pool.active >= 2, JSON.stringify(snapshot));
      assert.equal(typeof snapshot.pool.idle, 'number');
      assert.equal(snapshot.pool.max, 12);
      const direct = snapshots.find(row=>row.id==='configured:demo-reader');
      assert.equal(direct.pool.active, null);
      assert.equal(direct.pool.idle, null);
      assert.equal(direct.pool.max, null);
    });
    await check('Autocommit is off on both physical JDBC connections', async () => {
      assert.equal(workspace.autoCommit,false);
      assert.equal(observer.autoCommit,false);
      assert.equal(workspace.transactionOpen,false);
    });
    await check('SQL workspace ownership enforced across HTTP sessions', async () => {
      await other.api(`/sql/${workspace.id}`,{},400);
      await other.post(`/sql/${workspace.id}/commit`,{},400);
    });
    await check('Multiple SQL commands and quoted semicolons', async () => {
      const status = await execute(admin,workspace.id,"SELECT * FROM TEST_CUSTOMERS ORDER BY ID; SELECT 'eins;zwei' AS TEXT;");
      assert.equal(status.job.steps.length,2);
      assert.equal(result(status).rowCount,4);
      assert.equal(result(status,1).rows[0][0],'eins;zwei');
    });
    await check('CSV export preserves UTF-8, quotes, delimiters and optional formula protection', async () => {
      const status = await execute(admin,workspace.id,'SELECT NAME, EMAIL FROM TEST_CUSTOMERS ORDER BY ID');
      const data = result(status);
      const response = await admin.request(`/jerry/api/sql/${workspace.id}/results/${data.id}/csv?separator=%3B&encoding=UTF-8&bom=true&safe=true&null=NULL&header=true`);
      assert.equal(response.status,200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf');
      const csv = bytes.toString('utf8');
      assert.match(csv, /"Müller; Söhne"/);
      assert.match(csv, /Grüße aus Köln/);
      assert.match(csv, /"O'Brien ""Consulting"""/);
      assert.match(csv, /'=SUM\(A1:A2\)/);
      fs.writeFileSync(path.join(testRoot,'verified-export.csv'),bytes);
    });
    await check('SQL metadata includes table columns and primary key', async () => {
      const metadata = await admin.api(`/sql/${workspace.id}/metadata?schema=PUBLIC&table=TEST_CUSTOMERS`);
      assert.match(JSON.stringify(metadata), /BALANCE/);
      assert.match(JSON.stringify(metadata), /ID/);
    });
    await admin.post(`/sql/${workspace.id}/rollback`);
    await check('Commit, Rollback, Savepoint and isolation across two connections', async () => {
      await execute(admin,workspace.id,'DELETE FROM TEST_TRANSACTIONS WHERE ID BETWEEN 9000 AND 9010');
      await admin.post(`/sql/${workspace.id}/commit`);
      await execute(admin,workspace.id,"INSERT INTO TEST_TRANSACTIONS VALUES (9001, 'uncommitted')");
      assert.equal(result(await execute(admin,observer.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9001')).rows[0][0],'0');
      await admin.post(`/sql/${observer.id}/rollback`);
      await admin.post(`/sql/${workspace.id}/savepoint`,{name:'before_second'});
      await execute(admin,workspace.id,"INSERT INTO TEST_TRANSACTIONS VALUES (9002, 'savepoint rollback')");
      await admin.post(`/sql/${workspace.id}/rollback-savepoint`,{name:'before_second'});
      assert.equal(result(await execute(admin,workspace.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9002')).rows[0][0],'0');
      await admin.post(`/sql/${workspace.id}/commit`);
      assert.equal(result(await execute(admin,observer.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9001')).rows[0][0],'1');
      await admin.post(`/sql/${observer.id}/rollback`);
      await execute(admin,workspace.id,"INSERT INTO TEST_TRANSACTIONS VALUES (9003, 'rollback')");
      await admin.post(`/sql/${workspace.id}/rollback`);
      assert.equal(result(await execute(admin,observer.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9003')).rows[0][0],'0');
      await admin.post(`/sql/${observer.id}/rollback`);
    });
    await check('Error stops script and blocks further execution until rollback', async () => {
      const status = await execute(admin,workspace.id,"SELECT * FROM NONEXISTENT_JERRY_TABLE; INSERT INTO TEST_TRANSACTIONS VALUES (9004, 'must not run')");
      assert.equal(status.job.state,'ERROR');
      assert.equal(status.requiresRollback,true);
      assert.equal(status.job.steps.length,1);
      await admin.post(`/sql/${workspace.id}/execute`, {sql:'SELECT 1',requestId:'error_check_'+crypto.randomUUID()},409);
      await admin.post(`/sql/${workspace.id}/rollback`);
      assert.equal(result(await execute(admin,workspace.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9004')).rows[0][0],'0');
      await admin.post(`/sql/${workspace.id}/rollback`);
    });
    await check('Repeated request ID never executes DML twice', async () => {
      const requestId='retry_'+crypto.randomUUID();
      const sql="INSERT INTO TEST_TRANSACTIONS VALUES (9005, 'single execution')";
      await execute(admin,workspace.id,sql,requestId);
      await admin.post(`/sql/${workspace.id}/execute`,{sql,requestId});
      assert.equal(result(await execute(admin,workspace.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9005')).rows[0][0],'1');
      await admin.post(`/sql/${workspace.id}/execute`,{sql,requestId},409);
      await admin.post(`/sql/${workspace.id}/rollback`);
    });
    await check('Closing SQL tab rolls back uncommitted changes', async () => {
      const transient = await admin.post('/sql',{source:source.id});
      sqlSessions.push([admin,transient.id]);
      await execute(admin,transient.id,"INSERT INTO TEST_TRANSACTIONS VALUES (9006, 'close rollback')");
      await admin.api(`/sql/${transient.id}`,{method:'DELETE'});
      assert.equal(result(await execute(admin,observer.id,'SELECT COUNT(*) FROM TEST_TRANSACTIONS WHERE ID=9006')).rows[0][0],'0');
      await admin.post(`/sql/${observer.id}/rollback`);
    });
    await check('Database-enforced reader cannot modify data', async () => {
      await reader.post('/sql',{source:source.id},403);
      const readonly=await reader.post('/sql',{source:'configured:demo-reader'});
      sqlSessions.push([reader,readonly.id]);
      assert.equal(readonly.readOnly,true);
      assert.equal(result(await execute(reader,readonly.id,'SELECT COUNT(*) FROM TEST_CUSTOMERS')).rows[0][0],'4');
      const denied=await execute(reader,readonly.id,"INSERT INTO TEST_TRANSACTIONS VALUES (9007, 'forbidden')");
      assert.equal(denied.job.state,'ERROR');
      await reader.post(`/sql/${readonly.id}/rollback`);
    });
    await check('Current, rotated and compressed logs preserve Unicode and stacktraces', async () => {
      const logs=await admin.api('/logs');
      for (const name of ['demo.log','demo.log.1','demo.log.2.gz']) {
        const file=logs.find(log=>log.name===name);
        assert.ok(file,name);
        const page=await admin.api(`/logs/${file.id}?cursor=0&limit=100`);
        assert.match(JSON.stringify(page),/Grüße aus Köln/);
        assert.match(JSON.stringify(page),/IllegalStateException/);
        const download=await admin.request(`/jerry/api/logs/${file.id}/download`);
        assert.equal(download.status,200);
        assert.ok((await download.arrayBuffer()).byteLength>0);
      }
    });
    await check('Cross-file search includes compressed archives', async () => {
      const files=(await admin.api('/logs')).filter(log=>log.name.startsWith('demo.log')).map(log=>log.id);
      const search=await admin.post('/logs/search',{files,query:'Archiv-Testfehler',context:0});
      let status;
      for(let index=0;index<100;index++) {
        status=await admin.api(`/logs/search/${search.id}`);
        if(!['RUNNING','QUEUED'].includes(status.state)) break;
        await delay(50);
      }
      assert.equal(status.state,'DONE');
      assert.equal(status.hits.length,3);
      assert.ok(status.hits.some(hit=>hit.name.endsWith('.gz')));
      await admin.api(`/logs/search/${search.id}`,{method:'DELETE'});
    });
    await check('Log path traversal outside allowed roots rejected', async () => {
      const id=Buffer.from('0:../conf/tomcat-users.xml').toString('base64url');
      const response=await admin.request(`/jerry/api/logs/${id}`);
      assert.ok([400,403].includes(response.status),await response.text());
    });
    await check('WAR upload, JSP compile, stop/start/reload and undeploy', async () => {
      const response=await admin.request('/jerry/api/deploy?host=localhost&path=%2Fjerry-upload&compileJsps=true', {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:fs.readFileSync(path.join(environment.base,'webapps/jerry-demo.war'))});
      const text=await response.text();
      assert.equal(response.status,200,text);
      upload=(await admin.api('/applications')).find(app=>app.path==='/jerry-upload');
      assert.ok(upload?.running,text);
      for(const action of ['stop','start','reload']) {
        await admin.post(`/applications/${upload.id}`,{action});
        const current=(await admin.api('/applications')).find(app=>app.id===upload.id);
        assert.equal(current.running,action!=='stop');
      }
      await admin.post(`/applications/${upload.id}`,{action:'undeploy',confirmation:upload.id});
      assert.ok(!(await admin.api('/applications')).some(app=>app.id===upload.id));
      upload=null;
    });
    await check('Active request processors visible during concurrent load', async () => {
      const requests=Array.from({length:3},()=>fetch(base+'/jerry-demo/api?action=slow&ms=4000').then(response=>response.json()));
      try {
        await delay(200);
        const processors=await admin.api('/processors');
        assert.match(JSON.stringify(processors),/jerry-demo\/api/);
        let workerCount=null;
        for(let attempt=0;attempt<14;attempt++) {
          workerCount=(await admin.api('/summary')).connectorBusyWorkers;
          if(workerCount>=3) break;
          await delay(200);
        }
        assert.ok(workerCount>=3,`Shared executor must show busy workers, got ${workerCount}`);
      } finally { await Promise.allSettled(requests); }
    });
    await check('Quick Check and clean monitoring collection', async () => {
      const value=await admin.post('/quickcheck');
      assert.ok(!value.checks.some(check=>check.state==='ERROR'),JSON.stringify(value));
      assert.equal((await admin.api('/diagnostics')).collectionError,null);
    });
    await check('Logout invalidates authentication',async()=>{
      await other.post('/logout');
      await other.api('/me',{},401);
    });
  } finally {
    for(const [client,id] of sqlSessions) {
      try { await client.api(`/sql/${id}`,{method:'DELETE'}); } catch { }
    }
    if(upload) {
      try { await admin.post(`/applications/${upload.id}`,{action:'undeploy',confirmation:upload.id}); } catch { }
    }
    report.finished=new Date().toISOString();
    report.passed=report.checks.filter(check=>check.state==='PASS').length;
    report.failed=report.checks.filter(check=>check.state==='FAIL').length;
    fs.writeFileSync(path.join(testRoot,'integration-report.json'),JSON.stringify(report,null,2));
    console.log(`${report.passed} passed, ${report.failed} failed. Report: ${testRoot}/integration-report.json`);
  }
}
module.exports = { Client, base, environment, access, delay };
if (require.main === module) main().catch(error=>{ console.error(error.stack); process.exitCode=1; });
