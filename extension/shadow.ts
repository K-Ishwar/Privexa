import { injectShadowToggle, showSuggestion, hideSuggestion, isShadowAgentEnabled, addChatMessage, enableChatInput } from './ui/shadow-toggle';

let idleTimer: number | null = null;
const IDLE_TIMEOUT = 5000; // 5 seconds of friction
let triggerScanCallback: (() => void) | null = null;

export function initShadowAgent(onSuggestionNeeded: () => void, onSendChat: (text: string) => void) {
  triggerScanCallback = onSuggestionNeeded;
  
  // Inject the toggle on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => injectShadowToggle(onToggle, onSendChat));
  } else {
    injectShadowToggle(onToggle, onSendChat);
  }

  // Helper — is the suggestion card currently visible?
  const isSuggestionShowing = () => {
    const card = document.getElementById('privexa-suggestion-card');
    return !!card && card.style.display !== 'none';
  };

  // Focus tracking: if user focuses a field and waits, trigger suggestion
  document.addEventListener('focus', (e) => {
    const card = document.getElementById('privexa-suggestion-card');
    if (card && card.contains(e.target as Node)) return;  // focus inside card → ignore

    if (isSuggestionShowing()) hideSuggestion();
    if (!isShadowAgentEnabled) return;
    const target = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
      if (idleTimer) clearTimeout(idleTimer);
      // Wait 3 seconds on a field to trigger help
      idleTimer = window.setTimeout(() => {
        if (document.activeElement === target) evaluateFriction(target);
      }, 3000);
    }
  }, true);

  // Input tracking: cancel timer if they are actively typing so it doesn't interrupt
  document.addEventListener('input', (e) => {
    const target = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }, true);

  // Blur tracking: cancel timer if they leave the field
  document.addEventListener('blur', (e) => {
    const target = e.target as HTMLElement;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }, true);

  // click: only hide if click is OUTSIDE the card
  document.addEventListener('click', (e) => {
    const card = document.getElementById('privexa-suggestion-card');
    if (card && card.contains(e.target as Node)) return;  // click inside card → ignore
    if (isSuggestionShowing()) hideSuggestion();
  }, true);
}

function onToggle(enabled: boolean) {
  if (enabled) {
    console.log('[Privexa] Shadow Agent Enabled');
    showScanningAnimation();
    if (idleTimer) clearTimeout(idleTimer);
  } else {
    console.log('[Privexa] Shadow Agent Disabled');
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function showScanningAnimation() {
  if (document.getElementById('privexa-scan-anim')) return;

  const overlay = document.createElement('div');
  overlay.id = 'privexa-scan-anim';
  overlay.dataset.privexaId = 'scan-anim';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;';
  
  const laser = document.createElement('div');
  laser.style.cssText = 'position:absolute;left:0;right:0;height:4px;background:#3b82f6;box-shadow:0 0 20px 10px rgba(59,130,246,0.5);transform:translateY(-10px);animation:privexa-scan-sweep 2.0s ease-in-out;';
  
  const toast = document.createElement('div');
  toast.innerText = 'Page scanned successfully ✅';
  toast.style.cssText = 'position:absolute;bottom:30px;left:50%;transform:translateX(-50%);background:rgba(17,24,39,0.9);color:#fff;padding:8px 16px;border-radius:20px;font-family:sans-serif;font-size:13px;font-weight:600;opacity:0;transition:opacity 0.3s;box-shadow:0 4px 12px rgba(0,0,0,0.2);';

  if (!document.getElementById('privexa-scan-styles')) {
    const s = document.createElement('style');
    s.id = 'privexa-scan-styles';
    s.textContent = '@keyframes privexa-scan-sweep { 0% { transform:translateY(0); } 100% { transform:translateY(100vh); } }';
    document.head.appendChild(s);
  }

  overlay.appendChild(laser);
  overlay.appendChild(toast);
  document.body.appendChild(overlay);

  setTimeout(() => { toast.style.opacity = '1'; }, 1800);
  setTimeout(() => { toast.style.opacity = '0'; }, 3800);
  setTimeout(() => { overlay.remove(); }, 4200);
}

function evaluateFriction(targetElement?: HTMLElement) {
  if (!isShadowAgentEnabled) return;

  // Check for obvious error states first
  const errorElements = document.querySelectorAll('.error, [aria-invalid="true"], .invalid-feedback');
  const hasErrors = Array.from(errorElements).some((el: any) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });

  if (hasErrors) {
    console.log('[Privexa] Detected form error. Triggering suggestion.');
    if (triggerScanCallback) triggerScanCallback();
    return;
  }

  // If they paused on a field, trigger scan
  if (targetElement || !(globalThis as any)._shadowTargetNode) {
    console.log('[Privexa] Triggering suggestion.');
    if (triggerScanCallback) triggerScanCallback();
  }
}

(globalThis as any)._shadowEvaluateFriction = evaluateFriction;

export function displayShadowPlan(planAction: any, targetNode: HTMLElement | null, applyCallback: (mode: string) => void) {
  if (!isShadowAgentEnabled) return;
  
  let text = 'Privexa has a suggestion.';
  if (planAction.kind === 'FILL') {
    text = `AI wants to fill this field with your ${planAction.value.replace('{{', '').replace('}}', '')}.`;
  } else if (planAction.kind === 'FOCUS') {
    text = 'AI suggests you focus and complete this field next.';
  } else if (planAction.kind === 'CLICK') {
    text = 'AI suggests clicking here to continue.';
  } else if (planAction.kind === 'DONE') {
    text = 'AI thinks the form is complete. Please review.';
  }

  showSuggestion(text, targetNode, applyCallback);
}
