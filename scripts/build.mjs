import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,cp,stat,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const modules=process.env.PRIVEXA_NODE_MODULES || join(root,'node_modules');
const require=createRequire(join(modules,'../package.json'));
const {build}=require('esbuild');
for(const browser of ['chrome','firefox']){
 const out=join(process.env.PRIVEXA_DIST || join(root,'dist'),browser); await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
 for(const file of ['content','panel','workers/nlp.worker']) await build({entryPoints:[join(root,'extension',file+'.ts')],outfile:join(out,file+'.js'),bundle:true,format:'iife',platform:'browser',target:'es2022',nodePaths:[modules],minify:true});
 await build({entryPoints:[join(root,'extension/workers/vit.worker.ts')],outfile:join(out,'workers/vit.worker.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',nodePaths:[modules],minify:true,external:['*.onnx']});
 for(const file of ['panel.html','panel.css'])await cp(join(root,'extension',file),join(out,file));
 try{await stat(join(root,'extension/assets'));await cp(join(root,'extension/assets'),join(out,'assets'),{recursive:true});}catch{console.warn('Vision assets absent: run npm run setup:vision then rebuild.');}
 const manifest={manifest_version:3,name:'Privexa — SIH 26171',version:'0.1.0',description:'User-approved semantic-only browser assistance. No screenshot uploaded.',permissions:['activeTab','scripting','storage'],host_permissions:['http://127.0.0.1/*','https://huggingface.co/*','https://hf.co/*'],action:{default_popup:'panel.html',default_title:'Privexa'},content_scripts:[{matches:['<all_urls>'],js:['content.js']}],content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' data: http://127.0.0.1:8765 https://huggingface.co https://hf.co; img-src 'self' data: blob:; style-src 'self'"}};
 if(browser==='firefox')manifest.browser_specific_settings={gecko:{id:'privexa-local@sih.example',strict_min_version:'126.0'}};
 await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
}
console.log('Built dist/chrome and dist/firefox');
