import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connectorTraffic} from '../../frontend/src/connectorTraffic.ts';
const point=(time,received,sent,epoch='one',name='a')=>({time,connectors:[{objectName:name,bytesReceived:received,bytesSent:sent,counterEpoch:epoch,bytesReceivedRate:10,bytesSentRate:20}]});
test('volumes use cumulative counters even with sparse history and isolate connectors',()=>{
  const result=connectorTraffic([point(1000,100,200),point(11000,300,1000)],'a');
  assert.equal(result.upload,200); assert.equal(result.download,800); assert.equal(result.downloadAverage,80);
  assert.equal(result.downloadPeak,80); assert.equal(result.rates[1].downloadRate,80);
  assert.equal(connectorTraffic([point(1000,100,200)],'other').upload,null);
});
test('epoch changes skip resets even when new counters exceed old counters',()=>{
  const result=connectorTraffic([point(1000,10,20),point(2000,100,200,'two'),point(3000,120,250,'two')],'a');
  assert.equal(result.upload,20); assert.equal(result.download,50); assert.equal(result.resets,1); assert.equal(result.seconds,1);
  assert.equal(result.rates[1].uploadRate,null); assert.equal(result.rates[2].uploadRate,20);
});
test('counter decreases, missing samples and one-point histories never invent traffic',()=>{
  const result=connectorTraffic([point(1000,100,200),point(2000,1,2),{time:3000},point(4000,100,200)],'a');
  assert.equal(result.upload,null); assert.equal(result.resets,1); assert.equal(result.missing,1);
  assert.equal(connectorTraffic([point(1000,100,200)],'a').download,null);
});
