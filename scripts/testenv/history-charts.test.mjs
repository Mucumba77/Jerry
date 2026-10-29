import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartCsv, chartSegments, withEpochBreaks} from '../../frontend/src/chartData.ts';
import {appendHistory, mergeHistory, PERIODS, periodMilliseconds} from '../../frontend/src/history.ts';
import {completeTotal} from '../../frontend/src/monitorMath.ts';

test('all requested periods are available with the correct duration',()=>{
  for(const name of ['1h','12h','24h','7d']) assert.ok(PERIODS.some(item=>item.value===name));
  assert.equal(periodMilliseconds('12h'),12*3600000);
});
test('missing, unsupported and shared executor metrics do not appear as zero totals',()=>{
  assert.equal(completeTotal([{count:3},{count:4}],'count'),7);
  assert.equal(completeTotal([{count:3},{count:null}],'count'),null);
  assert.equal(completeTotal([{count:-1}],'count'),null);
  assert.equal(completeTotal([],'count'),null);
});
test('live points received while history loads survive the response, deduplicated and in order',()=>{
  const actual=mergeHistory([{time:100,value:1},{time:200,value:2}], [{time:150},{time:250},{time:250,value:4},{time:300}],200,120);
  assert.deepEqual(actual.map(item=>item.time),[200,250,300]); assert.equal(actual[1].value,4);
  assert.deepEqual(appendHistory(actual,{time:300,value:5},240).map(item=>item.time),[250,300]);
  assert.equal(appendHistory(actual,{time:1},240),actual);
});
test('missing values, reset markers and long sampling gaps split the chart',()=>{
  const points=[{time:0,value:1},{time:10000,value:2},{time:20000,value:null},{time:30000,value:3},
    {time:40000,value:4},{time:50000,value:5},{time:3600000,value:6},{time:3610000,value:7}];
  assert.deepEqual(chartSegments(points,10000).map(segment=>segment.map(item=>item.value)),[[1,2],[3,4,5],[6,7]]);
});
test('a quick JVM restart breaks the chart even when no samples are missing',()=>{
  const points=[{time:1000,value:1,processStarted:10,uptime:1000},{time:2000,value:2,processStarted:10,uptime:2000},
    {time:3000,value:3,processStarted:20,uptime:500}];
  assert.deepEqual(chartSegments(withEpochBreaks(points),1000).map(group=>group.map(point=>point.value)),[[1,2],[3]]);
});
test('CSV includes UTC timestamps, explicit gaps, Unicode and protects the header from formulas',()=>{
  const csv=chartCsv([{time:0,value:1.5},{time:1000,value:null},{time:NaN,value:2}], '=SUM(1;2) "ä"');
  assert.match(csv,/^\ufeff"Zeitpunkt \(UTC\)";"'=SUM\(1;2\) ""ä"""\r\n/);
  assert.match(csv,/"1970-01-01T00:00:00.000Z";1\.5\r\n/);
  assert.match(csv,/"1970-01-01T00:00:01.000Z";\r\n$/);
  assert.ok(chartCsv([{time:0,value:1}], '  =unsafe').includes("\"'  =unsafe\""));
});
