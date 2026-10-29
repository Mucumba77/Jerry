// Optional browser smoke test. Requires Playwright and a local Chromium executable.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client, access, base } = require('./verify.cjs');

async function main() {
  const user = new Client(); await user.login(access.user,access.password);
  const options={headless:true};
  if(process.env.JERRY_TEST_CHROMIUM) options.executablePath=process.env.JERRY_TEST_CHROMIUM;
  const browser=await chromium.launch(options);
  try {
    const context=await browser.newContext({viewport:{width:1440,height:900},locale:'de-DE'});
    const page=await context.newPage(), errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/jerry/login.html');
    const loginPicker=page.locator('#login-language');
    await loginPicker.selectOption('ru');
    assert.equal(await page.locator('html').getAttribute('lang'),'ru');
    assert.equal(await page.locator('[data-i18n="Passwort"]').textContent(),'Пароль');
    await context.addCookies([...user.cookies].map(([name,value])=>({name,value,url:base})));
    await page.goto(base+'/jerry/#dashboard');
    const picker=page.locator('.language-picker select');await picker.waitFor();
    const appLink=page.locator('.nav-group a[href="#applications"] span');
    for (const [code,expected] of [['de','Anwendungen'],['en','Applications'],['fr','Applications'],['es','Aplicaciones'],['it','Applicazioni'],['ru','Приложения'],['pt','Aplicativos'],['nl','Toepassingen'],['pl','Aplikacje'],['tr','Uygulamalar'],['zh','应用程序'],['ja','アプリケーション'],['ar','التطبيقات']]) {
      await picker.selectOption(code);
      await page.waitForFunction(([wanted])=>document.querySelector('.nav-group a[href="#applications"] span')?.textContent?.trim()===wanted,[expected],{timeout:15000});
      assert.equal(await page.locator('html').getAttribute('lang'),code);
    }
    assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
    await page.screenshot({path:path.resolve('.tools/jerry-testenv/arabic-review.png')});
    const shell=await page.locator('.main-shell').boundingBox(), sidebar=await page.locator('.sidebar').boundingBox();
    assert.ok(sidebar.x >= shell.x+shell.width-2,'Arabic sidebar must not overlap content');
    await page.setViewportSize({width:390,height:844});
    await page.locator('.mobile-menu').click();
    await page.waitForFunction(() => {
      const bounds=document.querySelector('.sidebar')?.getBoundingClientRect();
      return bounds && bounds.left>=0 && bounds.right<=window.innerWidth+1;
    },null,{timeout:3000});
    await page.screenshot({path:path.resolve('.tools/jerry-testenv/arabic-mobile-review.png')});
    const mobile=await page.locator('.sidebar').boundingBox();assert.ok(mobile.x>=0 && mobile.x+mobile.width<=392,JSON.stringify(mobile));
    await page.reload();await picker.waitFor();assert.equal(await picker.inputValue(),'ar');
    assert.deepEqual(errors,[],'Browser must not raise application errors');
    await context.close();console.log('PASS locale switching, login, persistence, and desktop/mobile RTL layout');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1});
