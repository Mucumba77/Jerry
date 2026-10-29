// Only the disposable loopback environment from verify.cjs is accepted.
const {Client,base,environment,access,delay}=require('./verify.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const report={started:new Date().toISOString(),environment,checks:[]};
async function check(name,action){const start=Date.now();try{const detail=await action();report.checks.push({name,state:'PASS',ms:Date.now()-start,detail});console.log('PASS '+name);}catch(error){report.checks.push({name,state:'FAIL',error:error.message});throw error;}}
async function until(action,predicate){for(let i=0;i<70;i++){const value=await action();if(predicate(value))return value;await delay(250);}throw Error('Collector timeout');}
async function main(){
  const admin=new Client(),viewer=new Client(); let sql;
  try{
    await admin.login(access.user,access.password); await viewer.login(access.viewer,access.viewerPassword);
    const apps=await admin.api('/applications');
    const framework=apps.find(row=>row.path==='/jerry-framework'); assert.ok(framework?.running,'Framework fixture must be running');
    const demo=apps.find(row=>row.path==='/jerry-demo');
    await fetch(base+'/jerry-framework/api');
    await check('JMX ownership, attribute reads and secret getter suppression',async()=>{
      await viewer.api(`/applications/${framework.id}/jmx`,{},403);
      const listing=await admin.api(`/applications/${framework.id}/jmx`);
      const health=listing.beans.find(row=>row.name==='de.mucumba.jerry.fixture:type=Health'); assert.ok(health,JSON.stringify(listing));
      assert.equal(health.association,'Anwendungs-Classloader');
      assert.equal(listing.beans.find(row=>row.name.startsWith('de.mucumba.jerry.fixture.shared:'))?.association,'Explizite Zuordnungsregel');
      assert.ok(!listing.beans.some(row=>row.name.startsWith('java.lang:')),'Global JVM beans must not appear as application-owned');
      const selected=await admin.api(`/applications/${framework.id}/jmx?bean=${health.id}`);
      assert.equal(selected.attributes.find(row=>row.name==='Label').value,'Jerry fixture health');
      for(const name of ['Password','Api_key','Private_Key']) {
        assert.equal(selected.attributes.find(row=>row.name===name).value,null);
        assert.match(selected.attributes.find(row=>row.name===name).state,/Geschützt/);
      }
      const body=await (await fetch(base+'/jerry-framework/api')).json(); assert.equal(body.secretReads,0);
      await admin.api(`/applications/${demo.id}/jmx?bean=${health.id}`,{},400);
      return {bean:health.name,association:health.association,secretReads:body.secretReads};
    });
    await check('Real Spring JPA and Hibernate FactoryBeans are discovered without enabling disabled statistics',async()=>{
      await admin.post(`/applications/${framework.id}/monitoring`,{mode:'EXTENDED'});
      const snapshot=await until(()=>admin.api(`/applications/${framework.id}/monitoring`),value=>value.collection.components?.orm.length===2);
      const rows=snapshot.collection.components.orm;
      const jpa=rows.find(row=>row.name==='fixtureJpa'),native=rows.find(row=>row.name==='fixtureHibernateDisabled');
      assert.equal(jpa.source,'Spring JPA'); assert.equal(jpa.enabled,true); assert.ok(jpa.queries>0);
      assert.equal(native.source,'Spring Hibernate'); assert.equal(native.enabled,false);
      const body=await (await fetch(base+'/jerry-framework/api')).json(); assert.equal(body.lazyConstructed,0);
      return {orm:rows,lazyConstructed:body.lazyConstructed};
    });
    await check('JNDI connection preselects PUBLIC and loads tables without schema mutation',async()=>{
      const sources=await admin.api('/datasources'); const source=sources.find(row=>row.name==='jdbc/JerryDemo'&&row.scope==='Global')||sources.find(row=>row.name==='jdbc/JerryDemo'); assert.ok(source,JSON.stringify(sources));
      sql=await admin.post('/sql',{source:source.id}); assert.equal(sql.autoCommit,false);
      const metadata=await admin.api(`/sql/${sql.id}/metadata`); assert.equal(metadata.currentSchema,'PUBLIC'); assert.equal(metadata.selectedSchema,'PUBLIC');
      assert.ok(metadata.tables.some(row=>row.TABLE_NAME==='TEST_CUSTOMERS'));
      const filtered=await admin.api(`/sql/${sql.id}/metadata?schema=INFORMATION_SCHEMA`); assert.equal(filtered.selectedSchema,'INFORMATION_SCHEMA'); assert.equal(filtered.currentSchema,'PUBLIC');
      assert.equal((await admin.api(`/sql/${sql.id}`)).transactionOpen,false);
      return {schema:metadata.currentSchema,tables:metadata.tables.length};
    });
    await check('Connector counters and rates record real upload and download bodies',async()=>{
      const before=await admin.api('/summary'), connector=before.connectors.find(row=>row.name.includes('16850')); assert.ok(connector);
      const upload=65536,download=131072;
      const response=await fetch(base+`/jerry-framework/api?download=${download}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:'u'.repeat(upload)});
      assert.equal(response.status,200); assert.ok((await response.arrayBuffer()).byteLength>=download);
      const after=await until(()=>admin.api('/summary'),value=>value.connectors.some(row=>row.objectName===connector.objectName&&row.bytesReceived>=connector.bytesReceived+upload&&row.bytesSent>=connector.bytesSent+download));
      const current=after.connectors.find(row=>row.objectName===connector.objectName);
      assert.equal(current.counterEpoch,connector.counterEpoch); assert.ok(current.bytesReceivedRate>0); assert.ok(current.bytesSentRate>0);
      return {uploadDelta:current.bytesReceived-connector.bytesReceived,downloadDelta:current.bytesSent-connector.bytesSent,counterEpoch:current.counterEpoch};
    });
  }finally{
    if(sql)await admin.api(`/sql/${sql.id}`,{method:'DELETE',json:{}},200).catch(()=>{});
    report.finished=new Date().toISOString(); fs.writeFileSync(path.resolve(__dirname,'../../.tools/jerry-testenv/enhancements-report.json'),JSON.stringify(report,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
