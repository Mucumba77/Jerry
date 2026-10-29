// Browser-level SQL completion checks against the disposable local Tomcat fixture.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {Client,access,base}=require('./verify.cjs');

async function main() {
  const client=new Client(); await client.login(access.user,access.password);
  const source=(await client.api('/datasources')).find(item=>item.name==='jdbc/JerryDemo');
  assert.ok(source,'The test data source must be available');
  const before=new Set((await client.api('/sql')).map(session=>session.id));
  const browser=await chromium.launch({headless:true,executablePath:process.env.JERRY_TEST_CHROMIUM});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'de-DE'});
    await context.addInitScript(()=>localStorage.setItem('jerry.language','de'));
    await context.addCookies([...client.cookies].map(([name,value])=>({name,value,url:base})));
    const page=await context.newPage(), errors=[], requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',request=>{const url=new URL(request.url());if(url.pathname.endsWith('/metadata') && url.searchParams.get('columnsOnly')==='true')requests.push(url);});
    await page.goto(base+'/jerry/#sql?source='+encodeURIComponent(source.id));
    const editor=page.locator('.cm-content').first();
    await editor.waitFor({timeout:20000});
    await page.getByText('TEST_CUSTOMERS',{exact:true}).first().waitFor({timeout:20000});
    async function type(text){await editor.click();await page.keyboard.press('Escape');await page.keyboard.press('Control+A');await page.keyboard.insertText(text);}
    async function open(){await page.keyboard.press('Control+Space');}
    const options=page.locator('.cm-tooltip-autocomplete [role="option"]');
    await type('SELECT * FROM TEST_C');await open();
    await options.filter({hasText:'TEST_CUSTOMERS'}).first().waitFor({timeout:10000});
    assert.equal(requests.length,0,'Table name suggestions must not request table columns');
    await options.filter({hasText:'TEST_CUSTOMERS'}).first().click();
    assert.match(await editor.innerText(),/SELECT \* FROM TEST_CUSTOMERS/);
    console.log('PASS table names complete without loading columns');

    await type('SELECT TEST_CUSTOMERS.');
    await options.filter({hasText:'NAME'}).first().waitFor({timeout:10000});
    assert.equal(requests.length,1,'Typing a dot must load only the selected table');
    assert.equal(requests[0].searchParams.get('table'),'TEST_CUSTOMERS');
    console.log('PASS typing a dot loads and suggests columns automatically');

    await type('SELECT t. FROM TEST_CUSTOMERS t');await page.keyboard.press('Home');
    for(let i=0;i<'SELECT t.'.length;i++)await page.keyboard.press('ArrowRight');
    await open();await options.filter({hasText:'NAME'}).first().waitFor({timeout:10000});
    assert.equal(requests.length,1,'The alias must reuse the cached columns');
    console.log('PASS table aliases reuse the per-connection column cache');

    await type('SELECT TEST_CUSTOMERS."NA');await open();
    await options.filter({hasText:'"NAME"'}).first().waitFor({timeout:10000});
    await options.filter({hasText:'"NAME"'}).first().click();
    assert.match(await editor.innerText(),/TEST_CUSTOMERS\."NAME"/);
    console.log('PASS completion preserves quoted identifiers');

    await type('SELECT COAL');await open();
    await options.filter({hasText:'COALESCE'}).first().waitFor({timeout:10000});
    console.log('PASS SQL function suggestions are available');

    await page.getByRole('combobox',{name:'Schema',exact:true}).selectOption('INFORMATION_SCHEMA');
    await page.getByText('TEST_CUSTOMERS',{exact:true}).first().waitFor({state:'hidden',timeout:20000});
    await type('SELECT TEST_CUSTOMERS.');await open();await page.waitForTimeout(500);
    assert.equal(await options.count(),0,'A table in another schema must not be suggested');
    assert.equal(requests.length,1,'An unknown table must not trigger a metadata lookup');
    await page.getByRole('combobox',{name:'Schema',exact:true}).selectOption('PUBLIC');
    await page.getByText('TEST_CUSTOMERS',{exact:true}).first().waitFor({timeout:20000});
    await type('SELECT TEST_CUSTOMERS.');await open();
    await options.filter({hasText:'NAME'}).first().waitFor({timeout:10000});
    assert.equal(requests.length,2,'Refreshing the selected schema must invalidate cached columns');
    console.log('PASS schema changes isolate and refresh cached metadata');

    await page.getByRole('button',{name:'Verbinden',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.sql-tab').length===2,null,{timeout:20000});
    await page.getByText('TEST_CUSTOMERS',{exact:true}).first().waitFor({timeout:20000});
    await type('SELECT TEST_CUSTOMERS.');await open();
    await options.filter({hasText:'NAME'}).first().waitFor({timeout:10000});
    assert.equal(requests.length,3,'Each SQL tab must use its own metadata cache');
    console.log('PASS SQL connections keep their completion caches separate');

    await type('-- TEST_CUSTOMERS.');await open();await page.waitForTimeout(500);
    assert.equal(await options.count(),0,'Suggestions must not appear inside comments');
    assert.deepEqual(errors,[]);
    console.log('PASS comments and browser errors');
    await context.close();
  } finally {
    await browser.close();
    for(const session of await client.api('/sql'))if(!before.has(session.id))await client.api('/sql/'+session.id,{method:'DELETE'});
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
