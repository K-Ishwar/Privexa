import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(process.env.PRIVEXA_NODE_MODULES||join(root,'node_modules'),'../package.json'));
const {chromium}=require('playwright');
const dist=process.env.PRIVEXA_DIST||join(root,'dist');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1200,height:900}});
const report=[];let scene;
async function check(name,fn){await fn();report.push({name,status:'passed'});}
const ask=m=>page.evaluate(m=>window.ask(m),m);
const scan=async()=>{scene=(await ask({type:'PRIVEXA_SCAN',goal:'NEXT_STEP'})).scene;return scene;};
const mk=(e,kind='CLICK')=>({requestId:scene.requestId,revision:scene.revision,mode:'DEMO',actions:[{kind,target:e.id,amount:0,reason:kind==='FOCUS'?'EMPTY_FIELD':'NEXT_CONTROL'}]});
try{
 await page.setContent('<label>Name <input autocomplete="name" value="Fictional Canary Name"></label><input type="email" value="canary@example.invalid"><input id="empty" placeholder="Phone"><form><button>Continue</button></form><button type="button" id="next">Continue</button><p id="text">Secret canary words</p><svg width="50" height="50"><circle cx="20" cy="20" r="15"/></svg>');
 await page.evaluate(()=>{window.chrome={runtime:{onMessage:{addListener(fn){window.listener=fn;}}}};window.ask=m=>new Promise(resolve=>window.listener(m,{},resolve));window.clicked=0;document.querySelector('#next').addEventListener('click',()=>window.clicked++);});
 await page.addScriptTag({path:join(dist,'chrome/content.js')});
 await check('Initial runtime and no raw text in scene',async()=>{await scan();assert.ok(scene);for(const raw of ['Fictional Canary Name','canary@example.invalid','Secret canary words'])assert.equal(JSON.stringify(scene).includes(raw),false);});
 await check('Submit disabled despite Continue label',async()=>{assert.ok(scene.elements.some(e=>e.role==='BUTTON'&&e.state==='DISABLED'));});
 await check('Safe Continue action executes',async()=>{const e=scene.elements.find(e=>e.role==='BUTTON'&&e.state==='AVAILABLE');assert.equal((await ask({type:'PRIVEXA_EXECUTE',plan:mk(e)})).ok,true);assert.equal(await page.evaluate(()=>window.clicked),1);});
 await check('Text mutation invalidates stale scene',async()=>{await scan();await page.evaluate(()=>document.querySelector('#text').firstChild.data='Changed');const e=scene.elements.find(e=>e.role==='BUTTON'&&e.state==='AVAILABLE');assert.equal((await ask({type:'PRIVEXA_EXECUTE',plan:mk(e)})).error,'INVALID_REQUEST');});
 await check('Unknown plan fields rejected',async()=>{await scan();const e=scene.elements.find(e=>e.role==='BUTTON'&&e.state==='AVAILABLE');const p=mk(e);p.raw='private';assert.equal((await ask({type:'PRIVEXA_EXECUTE',plan:p})).error,'INVALID_REQUEST');});
 await check('Changed input value rejects stale target without event',async()=>{await scan();const e=scene.elements.find(e=>e.state==='EMPTY'&&e.role==='INPUT');await page.evaluate(()=>document.querySelector('#empty').value='123');assert.equal((await ask({type:'PRIVEXA_EXECUTE',plan:mk(e,'FOCUS')})).error,'INVALID_REQUEST');});
 await check('Repeated injection remains usable',async()=>{await page.addScriptTag({path:join(dist,'chrome/content.js')});assert.ok(await scan());});
 if(process.env.PRIVEXA_TEST_TOKEN) await check('Real FastAPI DEMO round-trip to browser action',async()=>{await scan();const r=await fetch('http://127.0.0.1:8765/plan',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.PRIVEXA_TEST_TOKEN},body:JSON.stringify(scene)});assert.equal(r.status,200);const p=await r.json();assert.equal(p.mode,'DEMO');assert.equal((await ask({type:'PRIVEXA_EXECUTE',plan:p})).ok,true);});
 const result={environment:'Chromium 141 headless; content-script messaging harness, not installed-extension validation',checks:report};console.log(JSON.stringify(result,null,2));await writeFile(process.env.PRIVEXA_TEST_REPORT||join(root,'evaluation/browser-results.json'),JSON.stringify(result,null,2));
}finally{await browser.close();}
