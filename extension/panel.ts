import {validateScene,validatePlan,type Scene,type Plan,type Goal} from '../shared/schema';
import {analyzeVisual,releaseVision,extractTextFromImage} from '../vision/index';
import {mergeHybridScene} from '../vision/hybrid-scene';
import {detectPII,loadNlpModel} from './nlp';
import {modeManager} from './mode-manager';
import {analyzePageComplexity, type PageAnalysisResult, type PrivexaMode} from './page-analyser';
import {getVault, saveVault, resolveToken, tokenDisplayLabel, type VaultData} from './vault';
const api=(globalThis as any).browser || (globalThis as any).chrome;
const $=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const scanButton=$<HTMLButtonElement>('scan'),sendButton=$<HTMLButtonElement>('send'),executeButton=$<HTMLButtonElement>('execute'),autofillButton=$<HTMLButtonElement>('autofill');
let scene:Scene|null=null,plan:Plan|null=null,tabId:number|undefined,windowId:number|undefined,busy=false;

// Auto-fill DEMO token so the full 3-step flow works without any server
const tokenInput=$<HTMLInputElement>('token');
tokenInput.value='demo123';
tokenInput.placeholder='DEMO (offline) or PRIVEXA_TOKEN for real server';

function status(text:string,error=false){$('status').textContent=text;$('status').classList.toggle('error',error);}
function lock(value:boolean){
  busy=value;
  scanButton.disabled=value;
  sendButton.disabled=value||!scene;
  executeButton.disabled=value||!plan||plan.actions[0].kind==='DONE';
  autofillButton.disabled=value||!scene;
}
async function message(body:object){if(tabId===undefined)throw Error('No target tab.');const result=await api.tabs.sendMessage(tabId,body);if(!result||result.error)throw Error('Page changed or request rejected. Inspect again.');return result;}
async function fresh(){const tabs=await api.tabs.query({active:true,currentWindow:true});if(tabs[0]?.id!==tabId)throw Error('Active tab changed. Inspect again.');const c=await message({type:'PRIVEXA_CHECK',revision:scene?.revision});if(!c.valid)throw Error(`Page changed (${c.reason || 'unknown cause'}). Inspect again before sending or acting.`);}

// ── Vault UI wiring ──────────────────────────────────────────────────────────
const vaultToggle = $<HTMLDivElement>('vault-toggle');
const vaultBody   = $<HTMLDivElement>('vault-body');
const vaultChevron= $<HTMLSpanElement>('vault-chevron');
const vaultSaveBtn= $<HTMLButtonElement>('vault-save');
const vaultStatus = $<HTMLSpanElement>('vault-status');

let vaultOpen = false;
vaultToggle.addEventListener('click', async () => {
  vaultOpen = !vaultOpen;
  vaultBody.classList.toggle('open', vaultOpen);
  vaultChevron.classList.toggle('open', vaultOpen);
  vaultToggle.setAttribute('aria-expanded', String(vaultOpen));
  vaultBody.setAttribute('aria-hidden', String(!vaultOpen));
  if (vaultOpen) {
    // Populate fields from vault on first open
    const v = await getVault();
    (['NAME','EMAIL','PHONE','ADDRESS','AADHAAR','PAN','PASSWORD'] as const).forEach(k => {
      const el = $<HTMLInputElement>('vault-' + k);
      if (el && v[k]) el.value = v[k]!;
    });
  }
});

vaultSaveBtn.addEventListener('click', async () => {
  const data: VaultData = {};
  (['NAME','EMAIL','PHONE','ADDRESS','AADHAAR','PAN','PASSWORD'] as const).forEach(k => {
    const el = $<HTMLInputElement>('vault-' + k);
    if (el?.value.trim()) (data as any)[k] = el.value.trim();
  });
  await saveVault(data);
  vaultStatus.textContent = '✓ Saved & encrypted';
  vaultStatus.classList.add('visible');
  setTimeout(() => vaultStatus.classList.remove('visible'), 2500);
});

/** Show a confirm dialog before CLICK actions. Returns true if user proceeds. */
function confirmClick(buttonLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = 'privexa-confirm-overlay';
    overlay.innerHTML = `
      <div class="privexa-confirm-box">
        <h4>🖱️ Agent wants to click</h4>
        <p>Privexa is about to click the <strong>${buttonLabel}</strong> button on the page.<br>This may navigate or submit the form.</p>
        <div class="privexa-confirm-btns">
          <button class="btn-proceed" id="conf-proceed">▶ Proceed</button>
          <button class="btn-cancel"  id="conf-cancel">✕ Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = (result: boolean) => { overlay.remove(); resolve(result); };
    document.getElementById('conf-proceed')!.onclick = () => cleanup(true);
    document.getElementById('conf-cancel')!.onclick  = () => cleanup(false);
  });
}


// UI wiring for Mode Selector
const modeCards = document.querySelectorAll('.mode-card');
modeManager.subscribe((mode: PrivexaMode) => {
  modeCards.forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-mode') === mode);
  });
});
modeCards.forEach(card => {
  card.addEventListener('click', () => {
    const mode = card.getAttribute('data-mode') as PrivexaMode;
    if (mode) modeManager.setMode(mode);
  });
});

async function runSmartSuggestion(tid: number) {
  try {
    const results = await api.scripting.executeScript({
      target: { tabId: tid },
      func: analyzePageComplexity
    });
    if (results && results[0] && results[0].result) {
      const res = results[0].result as PageAnalysisResult;
      const modes: Record<string, string> = { 'ACCURACY': 'Accuracy Mode', 'BALANCED': 'Balanced Mode', 'LATENCY': 'Speed Mode' };
      $('suggestion-mode').textContent = modes[res.suggestedMode];
      $('suggestion-reason').textContent = res.reason;
      
      // Auto-select if no mode was explicitly chosen yet? 
      // For now, let's just default to the suggested mode on first load
      modeManager.setMode(res.suggestedMode);
    }
  } catch (e) {
    console.warn('Could not run page analyzer:', e);
    $('suggestion-mode').textContent = 'Speed Mode';
    $('suggestion-reason').textContent = 'Default mode (page analysis failed)';
  }
}

// Initial active tab detection for smart suggestion
api.tabs.query({active: true, currentWindow: true}).then((tabs: any[]) => {
  if (tabs[0] && tabs[0].id) {
    runSmartSuggestion(tabs[0].id);
  }
});

function draw(s:Scene){
  const canvas=$<HTMLCanvasElement>('map'),ctx=canvas.getContext('2d')!;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const scale=Math.min(canvas.width/s.viewport.width,canvas.height/s.viewport.height);
  const ox=(canvas.width-s.viewport.width*scale)/2;
  ctx.font='9px system-ui';
  // Draw DOM Elements
  for(const e of s.elements){
    const {x,y,width,height}=e.box;
    const px=ox+x*scale,py=y*scale,w=width*scale,h=height*scale;
    ctx.fillStyle=e.label.startsWith('[')?'#183c40':'#263753';
    ctx.strokeStyle=e.label.startsWith('[')?'#4a9b87':'#587697';
    ctx.fillRect(px,py,w,h);ctx.strokeRect(px,py,w,h);
    ctx.save();ctx.beginPath();ctx.rect(px,py,w,h);ctx.clip();
    ctx.fillStyle='#d5eee7';ctx.fillText(e.label,px+2,py+Math.min(11,h));
    ctx.restore();
  }
  
  // Draw YOLO Vision Regions (distinct yellow color)
  for(const r of s.vision.regions){
    const {x,y,width,height}=r.box;
    const px=ox+x*scale,py=y*scale,w=width*scale,h=height*scale;
    ctx.fillStyle='rgba(234, 179, 8, 0.15)'; // translucent yellow
    ctx.strokeStyle='#eab308'; // solid yellow
    ctx.fillRect(px,py,w,h);ctx.strokeRect(px,py,w,h);
    ctx.save();ctx.beginPath();ctx.rect(px,py,w,h);ctx.clip();
    ctx.fillStyle='#fef08a';ctx.fillText(`👁️ YOLO: ${r.label}`,px+2,py+Math.min(11,h));
    ctx.restore();
  }
}

async function redactImage(dataUrl:string,s:Scene):Promise<string>{
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d')!;
      
      // Draw the original clear image first
      ctx.drawImage(img,0,0);
      
      const sx=img.width/s.viewport.width,sy=img.height/s.viewport.height;
      const sensitive=new Set(['[PERSON_NAME]','[EMAIL]','[PHONE]','[AADHAAR]','[PAN]','[PASSWORD]','[ADDRESS]','[PAYMENT]','[PRIVATE_TEXT]','[PERSON_IMAGE]','[IMAGE]']);
      
      // Collect all sensitive bounding boxes
      const boxesToBlur: {x:number,y:number,w:number,h:number}[] = [];
      for(const e of s.elements){
        if(sensitive.has(e.label)){ boxesToBlur.push({x: e.box.x*sx, y: e.box.y*sy, w: e.box.width*sx, h: e.box.height*sy}); }
      }
      for(const r of s.vision.regions){
        if(sensitive.has(r.label)){ boxesToBlur.push({x: r.box.x*sx, y: r.box.y*sy, w: r.box.width*sx, h: r.box.height*sy}); }
      }
      
      if (boxesToBlur.length > 0) {
        ctx.save();
        ctx.beginPath();
        for (const b of boxesToBlur) {
          // Add a slight padding to the blur area to ensure text edges are covered
          const pad = 4;
          ctx.rect(b.x - pad, b.y - pad, b.w + (pad*2), b.h + (pad*2));
        }
        ctx.clip();
        
        // Apply Gaussian Blur and redraw the image over the clipped regions
        ctx.filter = 'blur(16px)';
        ctx.drawImage(img, 0, 0);
        
        // Add a sleek semi-transparent glass overlay on top of the blur
        ctx.filter = 'none';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fill();
        
        // Add a subtle border to clearly demarcate the redacted region
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        for (const b of boxesToBlur) {
          const pad = 4;
          ctx.strokeRect(b.x - pad, b.y - pad, b.w + (pad*2), b.h + (pad*2));
        }
        ctx.restore();
      }
      
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror=reject;img.src=dataUrl;
  });
}

async function generateYoloPreview(dataUrl:string, yoloDetections: any[], viewport: {width: number, height: number}):Promise<string>{
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      canvas.width=img.width;canvas.height=img.height;
      const ctx=canvas.getContext('2d')!;
      ctx.drawImage(img,0,0);
      
      const sx=img.width/viewport.width,sy=img.height/viewport.height;
      
      for(const r of yoloDetections){
        // YOLO box is relative to viewport (0 to 1) or absolute? Wait, yoloDetections gives box: {x,y,w,h} in absolute viewport coordinates?
        // Let's assume it matches s.vision.regions format
        const px = r.box.x*sx, py = r.box.y*sy, w = r.box.width*sx, h = r.box.height*sy;
        ctx.fillStyle='rgba(234, 179, 8, 0.2)';
        ctx.strokeStyle='#eab308';
        ctx.lineWidth = 2;
        ctx.fillRect(px,py,w,h);ctx.strokeRect(px,py,w,h);
        ctx.save();ctx.beginPath();ctx.rect(px,py,w,h);ctx.clip();
        ctx.font = '16px system-ui';
        ctx.fillStyle='#fef08a';
        ctx.fillText(`👁️ YOLO: ${r.label}`,px+4,py+20);
        ctx.restore();
      }
      
      // DEBUG OVERLAY
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(10, 10, 300, 40);
      ctx.fillStyle = '#fff';
      ctx.font = '20px system-ui';
      ctx.fillText(`YOLO Detections: ${yoloDetections.length}`, 20, 38);

      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror=reject;img.src=dataUrl;
  });
}

/** DEMO planner: runs on-device, zero network calls. Focus empty inputs first, then nav buttons, then DONE. */
function demoPlanner(safe:Scene):Plan{
  const emptyInput=safe.elements.find(e=>e.role==='INPUT'&&e.state==='EMPTY');
  if(emptyInput)return validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'FOCUS',target:emptyInput.id,amount:0,reason:'EMPTY_FIELD'}]},safe);
  const emptySelect=safe.elements.find(e=>e.role==='SELECT'&&e.state==='EMPTY');
  if(emptySelect)return validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'FOCUS',target:emptySelect.id,amount:0,reason:'EMPTY_FIELD'}]},safe);
  const safeBtn=safe.elements.find(e=>e.role==='BUTTON'&&e.state==='AVAILABLE'&&['CONTINUE','NEXT','REVIEW','BACK','CANCEL'].includes(e.label));
  if(safeBtn)return validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'CLICK',target:safeBtn.id,amount:0,reason:'NEXT_CONTROL'}]},safe);
  return validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'DONE',target:null,amount:0,reason:'REVIEW_REQUIRED'}]},safe);
}

// Step 1: Scan
scanButton.addEventListener('click',async()=>{
  if(busy)return;
  scene=null;plan=null;lock(true);
  $('plan').textContent='Awaiting sanitized context.';
  $('payload').textContent='Scanning locally...';
  $('redacted-preview-container').style.display='none';
  try{
    const tabs=await api.tabs.query({active:true,currentWindow:true});
    const tab=tabs[0];
    if(!tab?.id||!/^https?:\/\//.test(tab.url||''))throw Error('Open an ordinary HTTP(S) page; browser settings and extension pages cannot be inspected.');
    tabId=tab.id;windowId=tab.windowId;
    await api.scripting.executeScript({target:{tabId, allFrames: true},files:['content.js']});
    
    // Broadcast the current mode before scanning
    await api.tabs.sendMessage(tabId, { type: 'PRIVEXA_MODE_CHANGED', mode: modeManager.getMode() }).catch(() => {});
    
    const start=performance.now();
    const nlpChecked=$<HTMLInputElement>('nlp').checked;
    const goalVal = $<HTMLSelectElement>('goal').value as Goal;
    const modeVal = modeManager.getMode();
    let yoloPreview: string | null = null;
    
    const frameResults = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async (g: any, n: any, m: any) => {
        if (typeof (globalThis as any).__privexa_scan === 'function') {
          return await (globalThis as any).__privexa_scan(g, n, m);
        }
        return null;
      },
      args: [goalVal, nlpChecked, modeVal]
    });

    let topResult: any = null;
    const allElements: any[] = [];
    let fallbackNeeded = false;
    let anyTruncated = false;

    for (const r of frameResults) {
      if (r.result && r.result.scene) {
        if (!topResult || r.frameId === 0) topResult = r.result;
        allElements.push(...r.result.scene.elements);
        if (r.result.local.visualFallbackNeeded) fallbackNeeded = true;
        if (r.result.local.truncated) anyTruncated = true;
      }
    }
    
    if (!topResult) throw new Error('No frames returned a valid scene.');
    
    topResult.scene.elements = allElements;
    topResult.local.elementCount = allElements.length;
    topResult.local.visualFallbackNeeded = fallbackNeeded;
    topResult.local.truncated = anyTruncated;
    
    const result = topResult;
    let draft=validateScene(result.scene);
    const ms=performance.now()-start;
    $('latency').textContent=ms.toFixed(1);
    $('latency').className=ms<500?'latency-fast':'latency-slow';
    const shouldRunVision = modeVal === 'ACCURACY' || (modeVal === 'BALANCED' && result.local.visualFallbackNeeded) || $<HTMLInputElement>('vision').checked;
    
    if (shouldRunVision) {
      status('Running packaged face model and YOLO locally...');
      let raw=await api.tabs.captureVisibleTab(windowId,{format:'png'});
      draft.vision=await analyzeVisual(raw,draft.viewport,(p)=>api.runtime.getURL(p));
      // Image is NOT sent to the backend as requested by the user.
      // draft.privacy.mode='HYBRID';
      // draft.privacy.redactedPixels=await redactImage(raw,draft);

      let rawYoloDetections: any[] = [];
      status('Running YOLO26 for missing visual elements...');
      try {
        const worker = new Worker(api.runtime.getURL('workers/vit.worker.js'), { type: 'module' });
        worker.postMessage({ type: 'INIT' });
        const yoloDetections: any[] = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { worker.terminate(); reject(new Error('YOLO worker timed out after 10s')); }, 10000);
          worker.onmessage = (e) => {
            if (e.data.type === 'INIT_COMPLETE') {
              worker.postMessage({ type: 'DETECT', imageUrl: raw });
            } else if (e.data.type === 'DETECT_COMPLETE') {
              clearTimeout(timeout);
              resolve(e.data.results);
              worker.terminate();
            } else if (e.data.type === 'ERROR') {
              clearTimeout(timeout);
              reject(new Error(e.data.error));
              worker.terminate();
            }
          };
          worker.onerror = (err) => {
            clearTimeout(timeout);
            reject(new Error(String(err.message || err)));
            worker.terminate();
          };
        });

        console.log(`[Privexa] YOLO raw detections: ${yoloDetections.length}`, yoloDetections);
        status(`YOLO detected ${yoloDetections.length} elements. Normalizing coordinates...`);

        // Convert YOLO's physical image pixels back to CSS viewport pixels
        const tmpImg = new Image();
        tmpImg.src = raw;
        await new Promise((r) => { tmpImg.onload = r; });
        const sx = tmpImg.width / draft.viewport.width;
        const sy = tmpImg.height / draft.viewport.height;
        for (const det of yoloDetections) {
          det.box.x = Math.round(det.box.x / sx);
          det.box.y = Math.round(det.box.y / sy);
          det.box.width = Math.round(det.box.width / sx);
          det.box.height = Math.round(det.box.height / sy);
        }

        rawYoloDetections = yoloDetections;
        draft = mergeHybridScene(draft, yoloDetections, draft.viewport.width, draft.viewport.height);
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        console.error('YOLO inference failed:', errMsg, err);
        status(`⚠️ YOLO failed: ${errMsg}`, true);
      }
      
      // Local OCR Integration
      status('Running Local OCR on images within viewport...');
      for (const e of draft.elements) {
        if (e.role === 'IMAGE' && e.label === '[IMAGE]') {
          try {
            // Crop the specific image from the full screenshot
            const img = new Image();
            img.src = raw;
            await new Promise((r) => { img.onload = r; });
            const canvas = document.createElement('canvas');
            canvas.width = e.box.width; canvas.height = e.box.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const sx = img.width / draft.viewport.width;
              const sy = img.height / draft.viewport.height;
              ctx.drawImage(img, e.box.x * sx, e.box.y * sy, e.box.width * sx, e.box.height * sy, 0, 0, e.box.width, e.box.height);
              const chunkDataUrl = canvas.toDataURL('image/png');
              const ocrText = await extractTextFromImage(chunkDataUrl, (p)=>api.runtime.getURL(p));
              if (ocrText && ocrText.trim().length > 2) {
                if (nlpChecked) {
                  const ents = await detectPII(ocrText);
                  const isPer = ents.some((x:any)=>x.entity_group==='PER');
                  const isLoc = ents.some((x:any)=>x.entity_group==='LOC'||x.entity_group==='ORG');
                  if (isPer) e.label = '[PERSON_IMAGE]' as any;
                  else if (isLoc) e.label = '[TEXT_IN_IMAGE]' as any;
                } else {
                  e.label = '[TEXT_IN_IMAGE]' as any;
                }
              }
            }
          } catch (err) {
            console.error('Failed to OCR element', e.id, err);
          }
        }
      }

      yoloPreview = await generateYoloPreview(raw, rawYoloDetections, draft.viewport);
      raw='';
      await releaseVision();
    }
    if(nlpChecked){
      status('Loading multilingual NLP model...');
      await loadNlpModel((i:any)=>{if(i.status==='progress')status('Downloading NLP: '+Math.round(i.progress)+'%');});
      status('Applying NLP (Hindi/Marathi/English) to text...');
      for(const e of draft.elements){
        if(e.rawText){
          const ents=await detectPII(e.rawText);
          const isPer=ents.some((x:any)=>x.entity_group==='PER');
          const isLoc=ents.some((x:any)=>x.entity_group==='LOC'||x.entity_group==='ORG');
          if(isPer)e.label='[PERSON_NAME]';
          else if(isLoc)e.label='[ADDRESS]';
          delete e.rawText;
        }
      }
    }
    scene=validateScene(draft);
    await fresh();
    if(yoloPreview){
      $<HTMLImageElement>('redacted-preview').src=yoloPreview;
      $('redacted-preview-container').querySelector('h4')!.textContent = 'YOLO Vision Preview';
      $('redacted-preview-container').style.display='block';
    } else if(scene.privacy.redactedPixels){
      $<HTMLImageElement>('redacted-preview').src=scene.privacy.redactedPixels;
      $('redacted-preview-container').querySelector('h4')!.textContent = 'Base64 Redacted Payload Preview';
      $('redacted-preview-container').style.display='block';
    }
    $('payload').textContent=JSON.stringify(scene,null,2);
    $('count').textContent=String(scene.elements.length);
    $('model').textContent=scene.vision.status;
    draw(scene);
    const vMsg=scene.vision.status==='UNAVAILABLE'?'Vision unavailable (install assets). '
      :result.local.visualFallbackNeeded&&scene.vision.status==='NOT_RUN'?'Image detected as [IMAGE]. Enable face model for local inference. ':'';
    status((result.local.truncated?'Partial scan. ':'')+vMsg+'Payload ready. Click "2 - Approve & send labels".');
  }catch(e){scene=null;status(e instanceof Error?e.message:'Inspection failed.',true);$('payload').textContent='No request approved.';}
  finally{lock(false);}
});

// Step 2: Plan (DEMO or real server)
sendButton.addEventListener('click',async()=>{
  if(busy||!scene)return;
  lock(true);plan=null;
  try{
    await fresh();
    const rawToken=$<HTMLInputElement>('token').value.trim();
    const token=rawToken.toUpperCase(); // only used for DEMO-mode detection, rawToken sent to server
    const safe=validateScene(scene);
    if(!token||token==='DEMO'){
      status('DEMO planner: generating action on-device. Zero data sent externally.');
      await new Promise(r=>setTimeout(r,600));
      plan=demoPlanner(safe);
      await fresh();
      $('plan').textContent=JSON.stringify(plan,null,2);
      const k=plan.actions[0].kind;
      const desc=k==='FOCUS'?'Focus next empty field':k==='CLICK'?'Click navigation button':'Form complete - review required';
      status('DEMO plan: "'+desc+'". Review the action below, then click "3 - Approve action".');
    }else{
      const response=await fetch('http://127.0.0.1:8765/plan',{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+rawToken},body:JSON.stringify(safe),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Planner returned '+response.status+'. Check token and server.');
      const reader=response.body!.getReader();let n=0,chunks:Uint8Array[]=[];
      while(true){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>32768){await reader.cancel();throw Error('Planner response too large.');}chunks.push(r.value);}
      const bytes=new Uint8Array(n);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.length;}
      plan=validatePlan(JSON.parse(new TextDecoder().decode(bytes)),safe);
      await fresh();$('plan').textContent=JSON.stringify(plan,null,2);
      status(plan.mode==='DEMO'?'DEMO planner response validated.':plan.mode==='GEMINI'?'Gemini model response validated. Review before approving.':'OLLAMA model response validated. Review before approving.');
    }
  }catch(e){plan=null;status(e instanceof Error?e.message:'Planner request failed.',true);}
  finally{lock(false);}
});

// Step 3: Execute (manual)
executeButton.addEventListener('click',async()=>{
  if(busy||!scene||!plan)return;
  lock(true);
  try{
    await fresh();
    const validated=validatePlan(plan,scene);
    const action=validated.actions[0];

    // CLICK actions require user confirmation before proceeding
    if(action.kind==='CLICK'){
      const targetEl=scene.elements.find(e=>e.id===action.target);
      const label=targetEl?.label??'button';
      const proceed=await confirmClick(label);
      if(!proceed){status('Action cancelled by user.');return;}
    }

    // FILL: resolve the {{TOKEN}} from the local vault before sending to content script
    if(action.kind==='FILL'){
      if(!action.value)throw Error('FILL action missing token.');
      const vault=await getVault();
      const real=resolveToken(action.value,vault);
      if(!real){
        status(`⚠️ Vault is missing ${tokenDisplayLabel(action.value)}. Open "My Profile" and save it first.`,true);
        return;
      }
      // Attach resolvedValue client-side — NEVER part of any server response
      (action as any).resolvedValue=real;
    }

    await message({type:'PRIVEXA_EXECUTE',plan:validated});
    status('Action executed on-device. Page unmodified by any server. Inspect again for the next step.');
  }catch(e){status(e instanceof Error?e.message:'Action rejected.',true);}
  finally{plan=null;scene=null;lock(false);}
});

// Auto-fill loop: Scan → Send → Execute repeatedly until DONE or CLICK (which needs confirmation)
autofillButton.addEventListener('click', async () => {
  if(busy||!scene)return;
  lock(true);
  status('⚡ Auto-fill: starting loop...');
  try{
    const vault = await getVault();
    const hasVaultData = Object.keys(vault).length > 0;
    if(!hasVaultData){
      status('⚠️ Vault is empty! Open "My Profile", fill your details, and save before auto-filling.',true);
      return;
    }

    const rawToken=$<HTMLInputElement>('token').value.trim();
    const goalVal=$<HTMLSelectElement>('goal').value as Goal;
    const nlpChecked=$<HTMLInputElement>('nlp').checked;
    const modeVal=modeManager.getMode();
    let iteration=0;
    const MAX_ITER=20; // safety guard

    while(iteration++ < MAX_ITER){
      // ── Step 1: Scan ──
      status(`⚡ Auto-fill [${iteration}/${MAX_ITER}]: Scanning page...`);
      await api.scripting.executeScript({target:{tabId, allFrames:true},files:['content.js']});
      await api.tabs.sendMessage(tabId,{type:'PRIVEXA_MODE_CHANGED',mode:modeVal}).catch(()=>{});
      const frameResults=await api.scripting.executeScript({
        target:{tabId,allFrames:true},
        func:async(g:any,n:any,m:any)=>{
          if(typeof (globalThis as any).__privexa_scan==='function')return await (globalThis as any).__privexa_scan(g,n,m);
          return null;
        },
        args:[goalVal,nlpChecked,modeVal]
      });
      let topResult:any=null;const allElements:any[]=[];
      for(const r of frameResults){if(r.result?.scene){if(!topResult||r.frameId===0)topResult=r.result;allElements.push(...r.result.scene.elements);}}
      if(!topResult)throw new Error('No frames returned a valid scene.');
      topResult.scene.elements=allElements;
      scene=validateScene(topResult.scene);
      await fresh();

      // ── Step 2: Plan ──
      status(`⚡ Auto-fill [${iteration}/${MAX_ITER}]: Requesting plan...`);
      let currentPlan:Plan;
      const token=rawToken.toUpperCase();
      const safe=validateScene(scene);
      if(!rawToken||token==='DEMO'){
        // client-side demo planner (same logic as main demoPlanner but inline)
        const emptyFillable=safe.elements.find(e=>e.role==='INPUT'&&e.state==='EMPTY');
        if(emptyFillable){
          const LABEL_TOKEN:Record<string,string>={'[PERSON_NAME]':'{{NAME}}','NAME':'{{NAME}}','[EMAIL]':'{{EMAIL}}','EMAIL':'{{EMAIL}}','[PHONE]':'{{PHONE}}','PHONE':'{{PHONE}}','[ADDRESS]':'{{ADDRESS}}','ADDRESS':'{{ADDRESS}}','[AADHAAR]':'{{AADHAAR}}','AADHAAR':'{{AADHAAR}}','[PAN]':'{{PAN}}','PAN':'{{PAN}}','[PASSWORD]':'{{PASSWORD}}','PASSWORD':'{{PASSWORD}}'};
          const tok=LABEL_TOKEN[emptyFillable.label];
          if(tok){
            currentPlan=validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'FILL',target:emptyFillable.id,value:tok,amount:0,reason:'EMPTY_FIELD'}]},safe);
          }else{
            currentPlan=validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'FOCUS',target:emptyFillable.id,amount:0,reason:'EMPTY_FIELD'}]},safe);
          }
        }else{
          const btn=safe.elements.find(e=>e.role==='BUTTON'&&e.state==='AVAILABLE'&&['CONTINUE','NEXT','REVIEW','BACK','CANCEL'].includes(e.label));
          if(btn)currentPlan=validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'CLICK',target:btn.id,amount:0,reason:'NEXT_CONTROL'}]},safe);
          else currentPlan=validatePlan({requestId:safe.requestId,revision:safe.revision,mode:'DEMO',actions:[{kind:'DONE',target:null,amount:0,reason:'REVIEW_REQUIRED'}]},safe);
        }
      }else{
        const response=await fetch('http://127.0.0.1:8765/plan',{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json','Authorization':'Bearer '+rawToken},body:JSON.stringify(safe),signal:AbortSignal.timeout(15000)});
        if(!response.ok) {
          let detail = 'Planner returned ' + response.status;
          try {
            const errBody = await response.json();
            if (errBody.detail) detail = errBody.detail;
          } catch(e) {}
          throw Error(detail);
        }
        const bytes=await response.arrayBuffer();
        currentPlan=validatePlan(JSON.parse(new TextDecoder().decode(bytes)),safe);
      }
      plan=currentPlan;

      // ── Step 3: Execute Bulk Plan ──
      for (const action of currentPlan.actions) {
        if (action.kind === 'FILL') {
          if (!action.value) throw Error('FILL missing token');
          const real = resolveToken(action.value, vault);
          if (!real) throw Error(`Vault missing ${tokenDisplayLabel(action.value)}. Fill it in "My Profile" and restart.`);
          (action as any).resolvedValue = real;
        } else if (action.kind === 'CLICK') {
          const targetEl = scene.elements.find(e => e.id === action.target);
          const label = targetEl?.label ?? 'button';
          status(`⚡ Auto-fill: Waiting for your confirmation to click "${label}"...`);
          const proceed = await confirmClick(label);
          if (!proceed) throw Error('Auto-fill paused. Click resumed manually.');
        }
      }

      await fresh();
      await message({type: 'PRIVEXA_EXECUTE', plan: currentPlan});

      const hasDone = currentPlan.actions.some(a => a.kind === 'DONE');
      const hasClick = currentPlan.actions.some(a => a.kind === 'CLICK');
      const fillCount = currentPlan.actions.filter(a => a.kind === 'FILL').length;
      
      if (hasDone) {
        status('⚡ Auto-fill complete! All known fields have been filled. Review the form.');
        plan = null; scene = null;
        break;
      }

      if (hasClick) {
        status(`⚡ Auto-fill: Clicked. Waiting for page to settle...`);
      } else if (fillCount > 0) {
        status(`⚡ Auto-fill: Bulk filled ${fillCount} fields.`);
      }

      plan = null; scene = null;
      await new Promise(r => setTimeout(r, 800));
    }
    if(iteration>MAX_ITER)status('Auto-fill: safety limit reached. Inspect manually.',true);
  }catch(e){plan=null;scene=null;status(e instanceof Error?e.message:'Auto-fill failed.',true);}
  finally{lock(false);}
});

$<HTMLSelectElement>('goal').addEventListener('change',()=>{scene=null;plan=null;lock(false);status('Task changed. Inspect again.');});
window.addEventListener('pagehide',()=>{scene=null;plan=null;$<HTMLInputElement>('token').value='DEMO';void releaseVision();});
