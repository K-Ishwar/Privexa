import { isSameElement, validatePlan, validateScene, type Element as SceneElement, type Goal, type Label, type Plan, type Scene } from '../shared/schema';
import { classifyDomHints, replaceSensitive } from '../shared/privacy';
import { initShadowAgent, displayShadowPlan } from './shadow';
import { addChatMessage, enableChatInput, clearPersistentMode, showSuggestion } from './ui/shadow-toggle';

export type ScanLocal = { elementCount: number; truncated: boolean; visualFallbackNeeded: boolean };
export type ScanResult = { scene: Scene; local: ScanLocal };
export type ContentResponse = ScanResult | { ok: true } | { valid: boolean } | { error: string };

type NodeRef = { node: any; element: SceneElement };
type RuntimeLike = { onMessage?: { addListener: (listener: (...args: any[]) => any) => void } };
const root = globalThis as any;
const SINGLETON = '__privexaLocalContentInstalled_v1__';

let currentScene: Scene | null = null;
let currentRevision: string | null = null;
let currentMode: string = 'LATENCY';
let privexaSettleGraceUntil = 0;
const refs = new Map<string, NodeRef>();
let invalidationInstalled = false;
let lastInvalidationReason = '';



import { getVault, resolveToken, tokenDisplayLabel } from './vault';

// Always hot-swap the scan function so extension reloads don't require page refresh
(globalThis as any).__privexa_scan = scan;

// Initialize only after module state exists.
if (typeof window !== 'undefined' && window.top === window.self && !root[SINGLETON]) {
  root[SINGLETON] = true;
  installContentRuntime();
  
  // Initialize Shadow Agent
  initShadowAgent(async () => {
    try {
      let safe: Scene;
      if (currentScene && currentRevision && currentScene.revision === currentRevision) {
        safe = currentScene;
      } else {
        const scanResult = await scan('NEXT_STEP', false);
        safe = scanResult.scene;
      }
      
      const apiObj = (globalThis as any).browser || (globalThis as any).chrome;
      const rawToken = await new Promise<string>((resolve) => {
        apiObj.storage.local.get(['token'], (res: any) => resolve(res.token || ''));
      });
      
      let action: any = null;
      let targetNode: HTMLElement | null = null;
      let resolvedValue: string | null = null;

      if (!rawToken || rawToken.toUpperCase() === 'DEMO') {
        const emptyFillable = safe.elements.find(e => e.role === 'INPUT' && e.state === 'EMPTY');
        if (emptyFillable) {
          const LABEL_TOKEN: Record<string, string> = { '[PERSON_NAME]': '{{NAME}}', 'NAME': '{{NAME}}', '[EMAIL]': '{{EMAIL}}', 'EMAIL': '{{EMAIL}}', '[PHONE]': '{{PHONE}}', 'PHONE': '{{PHONE}}', '[ADDRESS]': '{{ADDRESS}}', 'ADDRESS': '{{ADDRESS}}', '[AADHAAR]': '{{AADHAAR}}', 'AADHAAR': '{{AADHAAR}}', '[PAN]': '{{PAN}}', 'PAN': '{{PAN}}', '[PASSWORD]': '{{PASSWORD}}', 'PASSWORD': '{{PASSWORD}}' };
          const tok = LABEL_TOKEN[emptyFillable.label];
          if (tok) {
            action = { kind: 'FILL', target: emptyFillable.id, value: tok, amount: 0, reason: 'EMPTY_FIELD' };
          } else {
            action = { kind: 'FOCUS', target: emptyFillable.id, amount: 0, reason: 'EMPTY_FIELD' };
          }
          targetNode = refs.get(emptyFillable.id)?.node as HTMLElement || null;
        } else {
          const btn = safe.elements.find(e => e.role === 'BUTTON' && e.state === 'AVAILABLE' && ['CONTINUE', 'NEXT', 'REVIEW', 'BACK', 'CANCEL'].includes(e.label));
          if (btn) {
            action = { kind: 'CLICK', target: btn.id, amount: 0, reason: 'NEXT_CONTROL' };
            targetNode = refs.get(btn.id)?.node as HTMLElement || null;
          } else {
            action = { kind: 'DONE', target: null, amount: 0, reason: 'REVIEW_REQUIRED' };
          }
        }
      } else {
        // Real Backend Call
        const response = await fetch('http://127.0.0.1:8765/plan', {
          method: 'POST',
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + rawToken
          },
          body: JSON.stringify(safe),
          signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw new Error('Planner backend failed.');
        const bytes = await response.arrayBuffer();
        const plan = validatePlan(JSON.parse(new TextDecoder().decode(bytes)), safe);
        action = plan.actions[0];
        targetNode = action.target ? (refs.get(action.target)?.node as HTMLElement || null) : null;
      }
      
      // If it's a FILL action, we MUST verify the vault has the token before proceeding.
      const vault = await getVault();
      if (action.kind === 'FILL') {
        const real = resolveToken(action.value, vault);
        if (!real) {
          throw new Error(`Vault missing ${tokenDisplayLabel(action.value)}.`);
        }
        resolvedValue = real;
      }

      displayShadowPlan(action, targetNode, async (mode: string) => {
        if (mode === 'guide') {
          if (!targetNode) return;
          targetNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetNode.focus();
          _showFieldTooltip(targetNode, '✦ Privexa → Please fill ' + (action.value ? tokenDisplayLabel(action.value) : 'this field'));
        } else {
          try {
            if (action.kind === 'FILL') {
              (action as any).resolvedValue = resolvedValue;
            }
            await execute({
              requestId: safe.requestId,
              revision: safe.revision,
              mode: 'GROQ',
              actions: [action]
            });
            if (action.kind !== 'DONE') {
              setTimeout(() => {
                const shadowAnimTrigger = (globalThis as any)._shadowEvaluateFriction;
                if (shadowAnimTrigger) shadowAnimTrigger();
              }, 600);
            }
          } catch (err: any) {
            clearPersistentMode();
            showSuggestion('Exec Error: ' + err.message, null, () => {});
            console.error('Execute error in Shadow Agent:', err);
          }
        }
      });
    } catch(e) {
      console.error('[Privexa] Shadow Agent failed to suggest:', e);
      clearPersistentMode();
      // Show the error message in the UI instead of falling back silently
      const msg = e instanceof Error ? e.message : 'Unknown error';
      showSuggestion('Error: ' + msg, null, () => {});
    }
  }, async (text: string) => {
    // 1. Sanitize the user's question before sending!
    const sanitizedQuestion = replaceSensitive(text);
    console.log(`[Privexa Chat] Original: "${text}" | Sanitized: "${sanitizedQuestion}"`);
    
    try {
      // 2. Capture and sanitize the page context
      let safeScene: Scene;
      if (currentScene && currentRevision && currentScene.revision === currentRevision) {
         safeScene = currentScene;
      } else {
         const scanResult = await scan('NEXT_STEP', false);
         safeScene = scanResult.scene;
      }
      
      // 3. Send to local Python proxy server
      const reqBody = { scene: safeScene, question: sanitizedQuestion, token: 'demo123' };
      const response = await fetch('http://127.0.0.1:8765/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
      
      if (!response.ok) throw new Error('Chat server returned ' + response.status);
      const data = await response.json();
      
      addChatMessage('bot', data.answer || 'I am sorry, I could not understand that.');
    } catch (e: any) {
      addChatMessage('bot', `Error: ${e.message}`);
    } finally {
      enableChatInput();
    }
  });
}

const TOOLTIP_HOST_ID = '__privexa_tip_host__';
function _getTooltipHost(): HTMLElement {
  let host = document.getElementById(TOOLTIP_HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = TOOLTIP_HOST_ID;
    host.dataset.privexaId = TOOLTIP_HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483645;pointer-events:none;';
    document.documentElement.appendChild(host);
  }
  return host;
}

/** Show a prominent field tooltip + glow ring. Text is provided by the caller. */
function _showFieldTooltip(el: HTMLElement, text: string) {
  const rect = el.getBoundingClientRect();
  const host = _getTooltipHost();
  
  // Create a separate glow element instead of modifying the target element's style,
  // to avoid triggering the page's MutationObserver when restoring styles later.
  const glow = document.createElement('div');
  glow.dataset.privexaId = 'glow';
  glow.style.cssText = [
    'position:fixed',
    `top:${rect.top}px`,
    `left:${rect.left}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    'border-radius:4px',
    'outline:3px solid #6366f1',
    'outline-offset:2px',
    'box-shadow:0 0 15px 4px rgba(99,102,241,0.4), 0 0 0 4px rgba(99,102,241,0.2)',
    'pointer-events:none',
    'z-index:2147483646',
    'transition:opacity 0.4s ease'
  ].join(';');
  host.appendChild(glow);

  const tip = document.createElement('div');
  tip.dataset.privexaId = 'tooltip';
  tip.innerHTML = `
    <div style="display: flex; align-items: center; gap: 10px;">
      <div style="width: 8px; height: 8px; background-color: #34d399; border-radius: 50%; box-shadow: 0 0 8px #34d399; animation: privexa-pulse 2s infinite;"></div>
      <span>${text}</span>
    </div>
  `;

  if (!document.getElementById('privexa-keyframes')) {
    const style = document.createElement('style');
    style.id = 'privexa-keyframes';
    style.textContent = `
      @keyframes privexa-pulse {
        0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.7); }
        70% { transform: scale(1.2); box-shadow: 0 0 0 6px rgba(52, 211, 153, 0); }
        100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
      }
      @keyframes privexa-float {
        0% { transform: translateY(0px); }
        50% { transform: translateY(-4px); }
        100% { transform: translateY(0px); }
      }
    `;
    document.head.appendChild(style);
  }

  tip.style.cssText = [
    'position:fixed',
    `top:${Math.max(12, rect.top - 54)}px`,
    `left:${Math.min(rect.left, window.innerWidth - 280)}px`,
    'background:rgba(17, 24, 39, 0.95)',
    'backdrop-filter:blur(8px)',
    'border:1px solid rgba(99, 102, 241, 0.5)',
    'color:#f3f4f6',
    'padding:10px 20px',
    'border-radius:12px',
    'font-weight:600',
    'font-size:14px',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'z-index:2147483647',
    'box-shadow:0 12px 28px -6px rgba(0, 0, 0, 0.4), 0 0 15px rgba(99, 102, 241, 0.25)',
    'pointer-events:none',
    'white-space:nowrap',
    'letter-spacing:0.3px',
    'opacity:0',
    'transform:translateY(10px)',
    'transition:opacity 0.4s ease, transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
    'animation: privexa-float 4s ease-in-out infinite'
  ].join(';');
  
  host.appendChild(tip);
  
  requestAnimationFrame(() => {
    tip.style.opacity = '1';
    tip.style.transform = 'translateY(0)';
  });

  setTimeout(() => {
    glow.style.opacity = '0';
    tip.style.opacity = '0';
    tip.style.transform = 'translateY(-10px)';
    setTimeout(() => { tip.remove(); glow.remove(); }, 400);
  }, 4500);
}


// ── In-page Redaction Overlay ────────────────────────────────────────────────
// IDs of existing overlay divs keyed by element UUID so we can update them
// without re-creating the DOM node on repeated scans.
const _overlayIds = new Map<string, HTMLElement>();
const OVERLAY_HOST_ID = '__privexa_overlay_host__';

const PII_LABELS = new Set<string>([
  '[PERSON_NAME]','[EMAIL]','[PHONE]','[AADHAAR]','[PAN]',
  '[PASSWORD]','[ADDRESS]','[PAYMENT]','[PRIVATE_TEXT]'
]);

/**
 * Inject frosted-glass blur divs directly over every sensitive element on the
 * live page.  Overlays move automatically when the page scrolls/resizes because
 * they use `position:fixed` anchored to getBoundingClientRect.
 */
function _applyPageRedactionOverlays(sceneElements: SceneElement[]): void {
  try {
    // Ensure we have a zero-cost host layer (pointer-events:none so users can
    // still interact with underlying form fields after dismissing the popup).
    let host = document.getElementById(OVERLAY_HOST_ID) as HTMLElement | null;
    if (!host) {
      host = document.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;z-index:2147483640;pointer-events:none;';
      document.documentElement.appendChild(host);
    }

    // Inject keyframes once
    if (!document.getElementById('privexa-overlay-keyframes')) {
      const s = document.createElement('style');
      s.id = 'privexa-overlay-keyframes';
      s.textContent = `
        @keyframes privexa-overlay-in {
          from { opacity:0; transform:scale(0.97); }
          to   { opacity:1; transform:scale(1); }
        }
      `;
      document.head.appendChild(s);
    }

    // Track which UUIDs we placed this pass so we can remove stale ones
    const alive = new Set<string>();

    // Interactive roles (INPUT, SELECT, CHECKBOX, BUTTON) must NEVER be overlaid
    // because users still need to click and type into them. Only text/static
    // elements (labels, headings, text nodes, images) should receive a blur overlay.
    const INTERACTIVE_ROLES = new Set(['INPUT', 'SELECT', 'CHECKBOX', 'BUTTON']);

    for (const el of sceneElements) {
      if (!PII_LABELS.has(el.label)) continue;
      if (INTERACTIVE_ROLES.has(el.role)) continue; // Never block interactive fields

      const ref = refs.get(el.id);
      if (!ref?.node?.isConnected) continue;

      // Use the live bounding rect (scroll-aware)
      const r = (ref.node as HTMLElement).getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      alive.add(el.id);

      let overlay = _overlayIds.get(el.id);
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.dataset.privexaId = el.id;
        host.appendChild(overlay);
        _overlayIds.set(el.id, overlay);
      }

      // Label badge text
      const badgeText = el.label.replace(/[\[\]]/g, '');

      overlay.style.cssText = [
        `left:${Math.max(0, r.left - 2)}px`,
        `top:${Math.max(0, r.top - 2)}px`,
        `width:${r.width + 4}px`,
        `height:${r.height + 4}px`,
        'position:fixed',
        'backdrop-filter:blur(14px) saturate(0.4)',
        '-webkit-backdrop-filter:blur(14px) saturate(0.4)',
        'background:rgba(79,70,229,0.18)',
        'border:1.5px solid rgba(99,102,241,0.55)',
        'border-radius:6px',
        'box-shadow:0 0 12px rgba(99,102,241,0.25)',
        'animation:privexa-overlay-in 0.25s ease-out both',
        'display:flex',
        'align-items:center',
        'justify-content:flex-end',
        'padding-right:6px',
        'overflow:hidden',
        'pointer-events:none',
      ].join(';');

      overlay.innerHTML = `
        <span style="
          background:rgba(99,102,241,0.85);
          color:#fff;
          font-size:10px;
          font-weight:700;
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          letter-spacing:0.5px;
          padding:2px 7px;
          border-radius:999px;
          white-space:nowrap;
          text-transform:uppercase;
          pointer-events:none;
        ">🔒 ${badgeText}</span>
      `;
    }

    // Remove overlays for elements no longer flagged as sensitive
    for (const [id, node] of _overlayIds) {
      if (!alive.has(id)) {
        node.remove();
        _overlayIds.delete(id);
      }
    }
  } catch { /* overlays are best-effort; must not break scan */ }
}

/** Remove ALL in-page redaction overlays (called when extension popup closes). */
export function clearPageRedactionOverlays(): void {
  document.getElementById(OVERLAY_HOST_ID)?.remove();
  _overlayIds.clear();
}

function randomUuid(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function installContentRuntime(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  installInvalidation();
  const runtime: RuntimeLike | undefined = root.browser?.runtime || root.chrome?.runtime;
  if (!runtime?.onMessage?.addListener) return;
  runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse?: (response: ContentResponse) => void) => {
    const response = handleMessage(message);
    // Firefox and newer Chromium accept a returned Promise; the callback branch
    // keeps compatibility with Chromium versions that require sendResponse.
    if (typeof sendResponse === 'function') {
      response.then(sendResponse).catch(() => sendResponse({ error: 'INVALID_REQUEST' }));
      return true;
    }
    return response;
  });
}

function installInvalidation(): void {
  if (invalidationInstalled || typeof document === 'undefined' || typeof window === 'undefined') return;
  invalidationInstalled = true;
  const invalidate = (mutations?: any) => {
    if (Date.now() < privexaSettleGraceUntil) return;

    // Ignore mutations caused by our own overlay host or tooltips — they must not
    // trigger a revision change that would make the stale-scene check fail.
    if (mutations && Array.isArray(mutations)) {
      const allOurs = mutations.every((m: any) => {
        const target = m.target as HTMLElement;
        if (!target) return false;
        
        // Ignore all mutations in <head> (e.g. third-party extensions injecting <style>)
        if (target === document.head || target.closest?.('head')) return true;

        // Ignore mutations that happen on or inside any of our UI components
        if (target.dataset?.privexaId || (typeof target.closest === 'function' && target.closest('[data-privexa-id]'))) return true;
        
        // Ignore childList mutations on document.body where only our elements are added/removed
        if (m.type === 'childList') {
          let onlyOurs = true;
          if (m.addedNodes.length === 0 && m.removedNodes.length === 0) return false;
          
          for (let i = 0; i < m.addedNodes.length; i++) {
            const n = m.addedNodes[i] as HTMLElement;
            if (n.nodeType === 1 && (n.id === OVERLAY_HOST_ID || n.id === TOOLTIP_HOST_ID || n.dataset?.privexaId || n.id === 'privexa-keyframes' || n.id === 'privexa-overlay-keyframes')) {
              continue;
            }
            onlyOurs = false; break;
          }
          if (!onlyOurs) return false;
          
          for (let i = 0; i < m.removedNodes.length; i++) {
            const n = m.removedNodes[i] as HTMLElement;
            if (n.nodeType === 1 && (n.id === OVERLAY_HOST_ID || n.id === TOOLTIP_HOST_ID || n.dataset?.privexaId || n.id === 'privexa-keyframes' || n.id === 'privexa-overlay-keyframes')) {
              continue;
            }
            onlyOurs = false; break;
          }
          return onlyOurs;
        }
        return false;
      });
      if (allOurs) return;
      if (!allOurs) {
        const failed = mutations.find((m: any) => {
          const target = m.target as HTMLElement;
          if (!target) return true;
          if (target === document.head || target.closest?.('head')) return false;
          if (target.dataset?.privexaId || (typeof target.closest === 'function' && target.closest('[data-privexa-id]'))) return false;
          if (m.type === 'childList') {
            let onlyOurs = true;
            if (m.addedNodes.length === 0 && m.removedNodes.length === 0) return true;
            for (let i = 0; i < m.addedNodes.length; i++) {
              const n = m.addedNodes[i] as HTMLElement;
              if (n.nodeType === 1 && (n.id === OVERLAY_HOST_ID || n.dataset?.privexaId || n.id === 'privexa-keyframes' || n.id === 'privexa-overlay-keyframes')) continue;
              onlyOurs = false; break;
            }
            if (!onlyOurs) return true;
            for (let i = 0; i < m.removedNodes.length; i++) {
              const n = m.removedNodes[i] as HTMLElement;
              if (n.nodeType === 1 && (n.id === OVERLAY_HOST_ID || n.dataset?.privexaId || n.id === 'privexa-keyframes' || n.id === 'privexa-overlay-keyframes')) continue;
              onlyOurs = false; break;
            }
            return !onlyOurs;
          }
          return true;
        }) || mutations[0];
        
        lastInvalidationReason = 'Mutation: ' + (failed.type || 'unknown') + ' on ' + ((failed.target as Element)?.tagName || 'unknown');
      }
    } else if (mutations && typeof mutations.type === 'string') {
      lastInvalidationReason = 'Event: ' + mutations.type;
    } else {
      lastInvalidationReason = 'Unknown cause';
    }
    currentRevision = randomUuid();
  };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(invalidate) : null;
  observer?.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('input', invalidate, true);
  document.addEventListener('change', invalidate, true);
}

function validGoal(v: unknown): v is Goal { return v === 'REVIEW_FORM' || v === 'NEXT_STEP' || v === 'SCROLL_DOWN'; }
function isElementNode(v: unknown): boolean { return !!v && typeof v === 'object' && (v as any).nodeType === 1; }
function textOf(el: any): string {
  try { return typeof el?.textContent === 'string' ? el.textContent.slice(0, 500) : ''; } catch { return ''; }
}
function hintsFor(el: any, kind: 'input' | 'button' | 'link' | 'text' | 'image' | 'select' | 'checkbox'): Parameters<typeof classifyDomHints>[0] {
  // All values below are local classification hints. They are never put in the scene.
  const get = (name: string): string => { try { return typeof el?.getAttribute === 'function' ? (el.getAttribute(name) || '') : ''; } catch { return ''; } };
  const visibleValue = kind === 'button' && typeof el?.value === 'string' ? el.value.slice(0, 500) : '';
  return { kind, type: typeof el?.type === 'string' ? el.type : get('type'), autocomplete: get('autocomplete'), name: get('name'), id: get('id'), placeholder: get('placeholder'), ariaLabel: get('aria-label'), text: [textOf(el) || visibleValue, ...Array.from(el.labels || []).map(textOf)].join(' ').slice(0, 1000) };
}
function viewport(): { width: number; height: number } {
  const width = Math.max(1, Math.min(10000, Math.floor(window.innerWidth || document.documentElement?.clientWidth || 1)));
  const height = Math.max(1, Math.min(10000, Math.floor(window.innerHeight || document.documentElement?.clientHeight || 1)));
  return { width, height };
}
function visible(el: any): boolean {
  try {
    if (!el || el.hidden || el.getAttribute?.('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return !!el.getClientRects?.().length;
  } catch { return false; }
}
function clippedBox(el: any, vp: { width: number; height: number }) {
  try {
    const r = el.getBoundingClientRect();
    if (!r) return { x: 0, y: 0, width: 0, height: 0 };
    const rLeft = Number(r.left) || 0;
    const rTop = Number(r.top) || 0;
    const rRight = Number(r.right) || 0;
    const rBottom = Number(r.bottom) || 0;
    const left = Math.max(0, Math.min(vp.width, Math.floor(rLeft)));
    const top = Math.max(0, Math.min(vp.height, Math.floor(rTop)));
    const right = Math.max(left, Math.min(vp.width, Math.ceil(rRight)));
    const bottom = Math.max(top, Math.min(vp.height, Math.ceil(rBottom)));
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch { return { x: 0, y: 0, width: 0, height: 0 }; }
}
function roleAndKind(el: any): { role: SceneElement['role']; kind: Parameters<typeof classifyDomHints>[0]['kind'] } | null {
  const tag = String(el?.tagName || '').toLowerCase();
  if (tag === 'input') {
    const type = String(el.type || '').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox') return { role: 'CHECKBOX', kind: 'checkbox' };
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return { role: 'BUTTON', kind: 'button' };
    return { role: 'INPUT', kind: 'input' };
  }
  if (tag === 'textarea' || el?.isContentEditable) return { role: 'INPUT', kind: 'input' };
  if (tag === 'select') return { role: 'SELECT', kind: 'select' };
  if (tag === 'button' || el?.getAttribute?.('role') === 'button') return { role: 'BUTTON', kind: 'button' };
  if (tag === 'a' || el?.getAttribute?.('role') === 'link') return { role: 'LINK', kind: 'link' };
  if (tag === 'img' || tag === 'canvas' || tag === 'svg' || tag === 'iframe' || tag === 'video') return { role: 'IMAGE', kind: 'image' };
  if (/^(p|h1|h2|h3|h4|h5|h6|label|legend|li|dt|dd|blockquote|caption|summary|output)$/.test(tag)) return { role: 'TEXT', kind: 'text' };
  // Leaf text containers such as spans are included by the bounded text walk.
  if (el?.children?.length === 0 && textOf(el).trim()) return { role: 'TEXT', kind: 'text' };
  return null;
}
function disabledOrSubmit(el: any, role: SceneElement['role']): boolean {
  try {
    if (el.disabled === true || el.getAttribute?.('aria-disabled') === 'true') return true;
    const typeAttr = el.getAttribute?.('type');
    const tag = String(el.tagName).toLowerCase();
    const type = String(el.type || typeAttr || (tag === 'button' && el.form && !typeAttr ? 'submit' : '')).toLowerCase();
    if (role === 'BUTTON' && (type === 'submit' || type === 'reset' || type === 'image')) return true;
    // A button without a type inside a form submits by default.
    if (role === 'BUTTON' && tag === 'button' && el.form && !typeAttr) return true;
    return false;
  } catch { return true; }
}
function stateFor(el: any, role: SceneElement['role']): SceneElement['state'] {
  if (disabledOrSubmit(el, role)) return 'DISABLED';
  if (role === 'BUTTON' || role === 'LINK' || role === 'IMAGE' || role === 'TEXT') return 'AVAILABLE';
  try {
    if (role === 'CHECKBOX') return el.checked ? 'FILLED' : 'EMPTY';
    return String(el.value ?? '').length > 0 ? 'FILLED' : 'EMPTY';
  } catch { return 'EMPTY'; }
}
function describe(el: any, id: string, vp: { width: number; height: number }, nlpEnabled: boolean): SceneElement | null {
  const rk = roleAndKind(el); if (!rk || !visible(el)) return null;
  const b = clippedBox(el, vp); if (b.width <= 0 || b.height <= 0) return null;
  const state = stateFor(el, rk.role);
  let label: Label = classifyDomHints(hintsFor(el, rk.kind!));
  let rawText: string | undefined;
  // A filled field with no safe semantic hint contains unknown text; do not let
  // the generic FIELD label imply that its value is safe to disclose.
  if ((state === 'FILLED' && label === 'FIELD') || (rk.role === 'TEXT' && label === '[PRIVATE_TEXT]')) {
    const localText = String(rk.role === 'TEXT' ? textOf(el) : (el.value ?? '')).slice(0, 2000);
    if (nlpEnabled && localText.trim()) rawText = localText;
    const replaced = replaceSensitive(localText);
    const tags = replaced.match(/\[(?:AADHAAR|PAN|PHONE|EMAIL|PERSON_NAME|PASSWORD|ADDRESS)\]/g);
    label = tags && new Set(tags).size === 1 ? tags[0] as Label : '[PRIVATE_TEXT]';
  }
  return { id, role: rk.role, label, state, box: b, rawText };
}
function candidates(): { nodes: any[]; truncated: boolean } {
  const found: any[] = [], seen = new Set<any>();
  const add = (el: any) => { if (isElementNode(el) && !seen.has(el)) { seen.add(el); found.push(el); } };
  try {
    document.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="link"],img,canvas,svg,iframe,video,p,h1,h2,h3,h4,h5,h6,label,legend,li,dt,dd,blockquote,caption,summary,output').forEach(add);
    // Include bounded leaf text containers (not the page's unbounded body text).
    const body = document.body;
    if (body && typeof document.createTreeWalker === 'function') {
      const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
      let visited = 0, textNode: any;
      while (visited++ < 1000 && (textNode = walker.nextNode())) {
        if (typeof textNode.nodeValue !== 'string' || !textNode.nodeValue.trim()) continue;
        const parent = textNode.parentElement;
        if (parent && parent.children?.length === 0) add(parent);
      }
    }
  } catch { /* malformed selector support should not break scanning */ }
  return { nodes: found, truncated: found.length > 200 };
}

export async function scan(goal: Goal, nlpEnabled: boolean = false, mode: string = 'LATENCY'): Promise<ScanResult> {
  if (!validGoal(goal)) throw new Error('invalid goal');
  currentMode = mode;
  installInvalidation();
  const vp = viewport();
  refs.clear();
  const revision = randomUuid();
  currentRevision = revision;
  const requestId = randomUuid();
  const { nodes, truncated } = candidates();
  const elements: SceneElement[] = [];
  let visualFallbackNeeded = false;
  for (const node of nodes.slice(0, 200)) {
    const id = randomUuid();
    const e = describe(node, id, vp, nlpEnabled); if (!e) continue;
    refs.set(id, { node, element: e }); elements.push(e);
    if (e.role === 'IMAGE') visualFallbackNeeded = true;
  }
  const scene: Scene = { version: '1.0', requestId, revision, goal, viewport: vp, elements, vision: { status: 'NOT_RUN', backend: 'NONE', durationMs: 0, regions: [] }, privacy: { mode: 'SEMANTIC_ONLY', rawPixels: false, freeText: nlpEnabled, redactedPixels: null } };
  currentScene = validateScene(scene);

  // Inject in-page frosted-glass overlays over every detected PII element.
  // DISABLED for better UX demo (Agent only outlines, does not blur UI).
  // try { _applyPageRedactionOverlays(elements); } catch {}

  return { scene: currentScene, local: { elementCount: elements.length, truncated, visualFallbackNeeded } };
}

function safeClick(node: any, element: SceneElement): boolean {
  const tag = String(node?.tagName || '').toLowerCase();
  if (element.role !== 'BUTTON' || tag !== 'button' && tag !== 'input') return false;
  const typeAttr = node.getAttribute?.('type');
  const type = String(node.type || typeAttr || (tag === 'button' && node.form && !typeAttr ? 'submit' : '')).toLowerCase();
  if (type === 'submit' || type === 'reset' || type === 'image') return false;
  if (node.form && tag === 'button' && !typeAttr) return false;
  return true;
}
function currentTarget(id: string, expected: SceneElement): { node: any; element: SceneElement } | null {
  const ref = refs.get(id);
  if (!ref || !ref.node?.isConnected || !visible(ref.node)) return null;
  const now = describe(ref.node, id, viewport(), false);
  if (!now || !isSameElement(now, expected)) return null;
  return { node: ref.node, element: now };
}

export async function execute(planValue: unknown): Promise<{ ok: true }> {
  if (!currentScene || !currentRevision || currentRevision !== currentScene.revision) throw new Error('stale scene');
  
  // Ignore page mutations (React DOM updates, async scroll events) for 1200ms
  // after execution so they don't incorrectly invalidate the page state.
  privexaSettleGraceUntil = Date.now() + 1200;

  const plan = validatePlan(planValue, currentScene);
  
  for (const action of plan.actions) {
    if (action.kind === 'SCROLL') { window.scrollBy(0, action.amount); continue; }
    if (action.kind === 'DONE') continue;
    const expected = currentScene.elements.find((e) => e.id === action.target);
    if (!expected || !action.target) throw new Error('invalid target');
    const live = currentTarget(action.target, expected);
    if (!live || live.element.state === 'DISABLED') throw new Error('stale target');
    
    if (action.kind === 'FOCUS') {
      if (!['INPUT', 'SELECT', 'CHECKBOX'].includes(live.element.role) || typeof live.node.focus !== 'function') throw new Error('unsafe focus');
      live.node.focus();
      
      try {
        let hintText = 'this field';
        if (live.element.label === '[PERSON_NAME]') hintText = 'your name';
        else if (live.element.label === '[EMAIL]') hintText = 'your email';
        else if (live.element.label === '[PHONE]') hintText = 'your phone number';
        else if (live.element.label === '[AADHAAR]') hintText = 'your Aadhaar';
        else if (live.element.label === '[PAN]') hintText = 'your PAN';
        else if (live.element.label === '[ADDRESS]') hintText = 'your address';
        else if (live.element.label === '[PASSWORD]') hintText = 'your password';
        
        _showFieldTooltip(live.node, '✦ Privexa → Please fill ' + hintText);
      } catch(e) {}
      
    } else if (action.kind === 'FILL') {
      const resolvedValue: string = (action as any).resolvedValue;
      if (typeof resolvedValue !== 'string') throw new Error('fill missing resolvedValue — vault lookup failed');
      if (!['INPUT', 'SELECT'].includes(live.element.role)) throw new Error('unsafe fill target');

      const node = live.node as HTMLInputElement | HTMLSelectElement;
      node.focus();

      if (node instanceof HTMLSelectElement) {
        const lower = resolvedValue.toLowerCase();
        let matched = false;
        for (const opt of Array.from(node.options)) {
          if (opt.value.toLowerCase() === lower || opt.textContent?.toLowerCase().trim() === lower) {
            node.value = opt.value;
            matched = true;
            break;
          }
        }
        if (!matched) node.value = resolvedValue;
      } else {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(node, resolvedValue);
        } else {
          node.value = resolvedValue;
        }
      }

      node.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

      try {
        const isPassword = live.element.label === '[PASSWORD]' || (node as HTMLInputElement).type === 'password';
        const displayValue = isPassword ? '●'.repeat(Math.min(resolvedValue.length, 8)) : resolvedValue.slice(0, 24) + (resolvedValue.length > 24 ? '…' : '');
        _showFieldTooltip(node, `✦ Privexa ✓ Filled: ${displayValue}`);
      } catch(e) {}

    } else {
      if (!safeClick(live.node, live.element)) throw new Error('unsafe click');
      live.node.click();
    }
  }
  
  currentRevision = randomUuid(); // Consume approval for the entire batch
  return { ok: true };
}

export async function check(revision: unknown): Promise<{ valid: boolean, reason?: string }> {
  const valid = typeof revision === 'string' && !!currentScene && revision === currentScene.revision && currentRevision === currentScene.revision;
  return { valid, reason: valid ? undefined : lastInvalidationReason };
}

export async function handleMessage(message: unknown): Promise<ContentResponse> {
  try {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid request');
    const m = message as Record<string, unknown>;
    if (m.type === 'PRIVEXA_SCAN') {
      if (Object.keys(m).some((k) => k !== 'type' && k !== 'goal' && k !== 'nlpEnabled' && k !== 'mode') || !validGoal(m.goal)) throw new Error('invalid scan');
      return await scan(m.goal, !!m.nlpEnabled, (m.mode as string) || 'LATENCY');
    }
    if (m.type === 'PRIVEXA_MODE_CHANGED') {
      if (m.mode) currentMode = m.mode as string;
      return { ok: true };
    }
    if (m.type === 'PRIVEXA_EXECUTE') {
      if (Object.keys(m).some((k) => k !== 'type' && k !== 'plan') || !('plan' in m)) throw new Error('invalid execute');
      return await execute(m.plan);
    }
    if (m.type === 'PRIVEXA_CHECK') {
      if (Object.keys(m).some((k) => k !== 'type' && k !== 'revision') || !('revision' in m)) throw new Error('invalid check');
      return await check(m.revision);
    }
    throw new Error('unknown message');
  } catch {
    return { error: 'INVALID_REQUEST' };
  }
}
