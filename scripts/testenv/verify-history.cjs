// Read-only checks against the isolated loopback Tomcat test environment.
const {Client,environment,access}=require('./verify.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const report={started:new Date().toISOString(),warSha256:environment.warSha256,checks:[]};
async function main(){
  const client=new Client(); await client.login(access.user,access.password);
  for(const [label,duration] of [['15m',15*60e3],['1h',36e5],['6h',6*36e5],['12h',12*36e5],['24h',24*36e5],['7d',7*24*36e5],['30d',30*24*36e5]]) {
    try {
      const to=Date.now(),from=to-duration;
      const points=await client.api('/history?'+new URLSearchParams({from:String(from),to:String(to),points:'10'}));
      assert.ok(points.length>0 && points.length<=10,`${label}: ${points.length} points`);
      assert.ok(points.every(point=>Number.isFinite(point.time)&&point.time>=from&&point.time<=to));
      assert.ok(points.every((point,i)=>!i||point.time>=points[i-1].time),'chronological order');
      assert.ok(points.at(-1).time>=to-120000,`${label} must include recent data`);
      report.checks.push({name:label,state:'PASS',points:points.length,last:points.at(-1).time}); console.log('PASS history '+label);
    } catch(error) { report.checks.push({name:label,state:'FAIL',error:error.message}); throw error; }
  }
}
main().catch(error=>{if(!report.checks.some(row=>row.state==='FAIL'))report.checks.push({name:'Runner prerequisites',state:'FAIL',error:error.message});console.error(error.stack);process.exitCode=1;}).finally(()=>{
  report.finished=new Date().toISOString();
  fs.writeFileSync(path.resolve(__dirname,'../../.tools/jerry-testenv/history-report.json'),JSON.stringify(report,null,2));
});
