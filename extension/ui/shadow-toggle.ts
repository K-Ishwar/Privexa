// Shadow Toggle UI — compact, premium floating widget

export let isShadowAgentEnabled = false;
export let persistentMode: string | null = null;
export function clearPersistentMode() { persistentMode = null; }
type SuggestionCallback = (mode: string) => void;

let onToggleCallback: ((enabled: boolean) => void) | null = null;
let onSendChatCallback: ((text: string) => void) | null = null;
// Mutable callback ref so reuse of the DOM element picks up fresh callbacks
let _currentAcceptCallback: SuggestionCallback | null = null;

export function injectShadowToggle(onToggle: (enabled: boolean) => void, onSendChat: (text: string) => void) {
  onToggleCallback = onToggle;
  onSendChatCallback = onSendChat;
  if (document.getElementById('privexa-fab')) return;

  // Inject styles
  const style = document.createElement('style');
  style.textContent = `
    #privexa-fab {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
    }
    #privexa-suggestion-card {
      pointer-events: auto;
      background: #1a1a2e;
      border: 1px solid rgba(99, 179, 237, 0.3);
      border-radius: 12px;
      padding: 12px 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,179,237,0.1);
      max-width: 240px;
      min-width: 200px;
      display: none;
      flex-direction: column;
      gap: 10px;
      backdrop-filter: blur(12px);
      animation: privexa-slide-up 0.2s ease;
    }
    @keyframes privexa-slide-up {
      from { opacity:0; transform: translateY(8px); }
      to   { opacity:1; transform: translateY(0); }
    }
    #privexa-suggestion-card .pvx-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #privexa-suggestion-card .pvx-icon {
      font-size: 14px;
    }
    #privexa-suggestion-card .pvx-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: #63b3ed;
    }
    #privexa-suggestion-text {
      font-size: 12px;
      line-height: 1.5;
      color: #e2e8f0;
      margin: 0;
    }
    #privexa-suggestion-card .pvx-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .pvx-actions-vertical {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pvx-action-btn {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      transition: all 0.2s;
      text-align: left;
    }
    .pvx-action-btn:hover {
      background: rgba(255,255,255,0.1);
      border-color: rgba(99, 179, 237, 0.4);
    }
    .pvx-action-btn strong {
      color: #fff;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .pvx-action-btn span {
      color: #94a3b8;
      font-size: 10px;
    }
    .pvx-action-btn.auto-mode:hover {
      background: linear-gradient(135deg, rgba(34,197,94,0.2), rgba(22,163,74,0.2));
      border-color: #22c55e;
    }
    #privexa-dismiss-btn {
      background: transparent;
      color: #64748b;
      border: none;
      font-size: 11px;
      cursor: pointer;
      padding: 4px;
      border-radius: 5px;
      align-self: flex-end;
      margin-top: 4px;
    }
    #privexa-dismiss-btn:hover { color: #94a3b8; background: rgba(255,255,255,0.05); }
    #privexa-toggle-btn {
      pointer-events: auto;
      padding: 8px 14px;
      border-radius: 20px;
      border: 1.5px solid rgba(99, 179, 237, 0.4);
      background: #1a1a2e;
      color: #94a3b8;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: all 0.2s;
      letter-spacing: 0.3px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #privexa-toggle-btn:hover { border-color: #63b3ed; color: #e2e8f0; }
    #privexa-toggle-btn.active {
      background: linear-gradient(135deg, #1e3a5f, #1e2a5f);
      border-color: #3b82f6;
      color: #93c5fd;
    }
    #privexa-toggle-btn .pvx-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #475569;
      transition: background 0.2s;
    }
    #privexa-toggle-btn.active .pvx-dot { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
    
    #privexa-chat-card {
      pointer-events: auto;
      background: #1a1a2e;
      border: 1px solid rgba(99, 179, 237, 0.3);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(99,179,237,0.1);
      width: 350px;
      display: none;
      flex-direction: column;
      backdrop-filter: blur(12px);
      animation: privexa-slide-up 0.2s ease;
      overflow: hidden;
    }
    #privexa-chat-header {
      background: rgba(0,0,0,0.2);
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      color: #63b3ed;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    #privexa-chat-close { cursor: pointer; color: #64748b; }
    #privexa-chat-close:hover { color: #fff; }
    #privexa-chat-messages {
      height: 350px;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .pvx-msg {
      max-width: 85%;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.4;
      word-wrap: break-word;
    }
    .pvx-msg.user { background: #3b82f6; color: #fff; align-self: flex-end; border-bottom-right-radius: 2px; }
    .pvx-msg.bot { background: rgba(255,255,255,0.1); color: #e2e8f0; align-self: flex-start; border-bottom-left-radius: 2px; }
    #privexa-chat-input-area {
      display: flex;
      padding: 8px;
      border-top: 1px solid rgba(255,255,255,0.05);
      gap: 6px;
    }
    #privexa-chat-input {
      flex: 1;
      background: rgba(0,0,0,0.2);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 6px;
      padding: 6px;
      color: #fff;
      font-size: 12px;
      outline: none;
    }
    #privexa-chat-input:focus { border-color: #63b3ed; }
    #privexa-chat-send {
      background: #3b82f6;
      border: none;
      color: #fff;
      border-radius: 6px;
      padding: 0 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
    }
    #privexa-chat-send:hover { background: #2563eb; }
    #privexa-chat-send:disabled { opacity: 0.5; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  const fab = document.createElement('div');
  fab.id = 'privexa-fab';
  fab.dataset.privexaId = 'fab';

  const card = document.createElement('div');
  card.id = 'privexa-suggestion-card';
  card.innerHTML = `
    <div class="pvx-header">
      <span class="pvx-icon">🤖</span>
      <span class="pvx-label">Privexa</span>
    </div>
    <p id="privexa-suggestion-text"></p>
    <div class="pvx-actions-vertical">
      <button class="pvx-action-btn" id="pvx-exec-guide">
        <strong>🎯 Guide Mode</strong>
        <span>Points out the next step without typing</span>
      </button>
      <button class="pvx-action-btn auto-mode" id="pvx-exec-auto">
        <strong>⚡ Auto-Fill Mode</strong>
        <span>Securely types data from your Vault</span>
      </button>
    </div>
    <button id="privexa-dismiss-btn">Dismiss ✖</button>
  `;
  fab.appendChild(card);

  // Wire up buttons
  card.querySelector('#pvx-exec-guide')!.addEventListener('click', (e) => {
    e.stopPropagation();
    persistentMode = 'guide';
    if (_currentAcceptCallback) (_currentAcceptCallback as any)('guide');
    hideSuggestion();
  });
  card.querySelector('#pvx-exec-auto')!.addEventListener('click', (e) => {
    e.stopPropagation();
    persistentMode = 'auto';
    if (_currentAcceptCallback) (_currentAcceptCallback as any)('auto');
    hideSuggestion();
  });
  card.querySelector('#privexa-dismiss-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    hideSuggestion();
  });

  // Chat card
  const chatCard = document.createElement('div');
  chatCard.id = 'privexa-chat-card';
  chatCard.innerHTML = `
    <div id="privexa-chat-header">
      <span>💬 Privexa Secure Chat</span>
      <span id="privexa-chat-close">✖</span>
    </div>
    <div id="privexa-chat-messages"></div>
    <div id="privexa-chat-input-area">
      <input type="text" id="privexa-chat-input" placeholder="Ask about this page..." />
      <button id="privexa-chat-send">Send</button>
    </div>
  `;
  fab.appendChild(chatCard);

  chatCard.querySelector('#privexa-chat-close')!.addEventListener('click', () => {
    chatCard.style.display = 'none';
  });

  const sendBtn = chatCard.querySelector('#privexa-chat-send') as HTMLButtonElement;
  const chatInput = chatCard.querySelector('#privexa-chat-input') as HTMLInputElement;

  const handleSend = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    addChatMessage('user', text);
    chatInput.value = '';
    sendBtn.disabled = true;
    if (onSendChatCallback) onSendChatCallback(text);
  };
  sendBtn.addEventListener('click', handleSend);
  chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSend(); });

  // Button row container
  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';

  const chatBtn = document.createElement('button');
  chatBtn.id = 'privexa-chat-toggle';
  chatBtn.innerHTML = `💬 Chat`;
  chatBtn.style.cssText = `pointer-events: auto; padding: 8px 14px; border-radius: 20px; border: 1.5px solid rgba(99, 179, 237, 0.4); background: #1a1a2e; color: #94a3b8; font-size: 11px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: all 0.2s; letter-spacing: 0.3px;`;
  chatBtn.addEventListener('click', () => {
    chatCard.style.display = chatCard.style.display === 'flex' ? 'none' : 'flex';
  });
  btnRow.appendChild(chatBtn);

  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'privexa-toggle-btn';
  toggleBtn.innerHTML = `<span class="pvx-dot"></span> Privexa`;
  toggleBtn.addEventListener('click', () => {
    const enabled = toggleBtn.classList.toggle('active');
    isShadowAgentEnabled = enabled;
    if (!enabled) persistentMode = null; // Clear mode when disabled
    toggleBtn.innerHTML = enabled ? '<span class="pvx-dot"></span> Agent Active' : '<span class="pvx-dot"></span> Privexa';
    if (!enabled) {
      hideSuggestion();
      chatCard.style.display = 'none';
    }
    if (onToggleCallback) onToggleCallback(enabled);
  });
  btnRow.appendChild(toggleBtn);
  fab.appendChild(btnRow);

  document.body.appendChild(fab);
}

export function showSuggestion(text: string, targetNode: HTMLElement | null, onAccept: SuggestionCallback) {
  if (!isShadowAgentEnabled) return;

  // Update the mutable callback ref
  _currentAcceptCallback = onAccept;

  if (persistentMode) {
    onAccept(persistentMode as any);
    return;
  }

  const card = document.getElementById('privexa-suggestion-card');
  const textEl = document.getElementById('privexa-suggestion-text');
  if (!card || !textEl) return;

  textEl.textContent = text;

  // Position above target field if available, else show in FAB
  if (targetNode) {
    const rect = targetNode.getBoundingClientRect();
    card.style.position = 'fixed';
    card.style.bottom = 'auto';
    card.style.right = 'auto';
    card.style.top = Math.max(8, rect.top - 130) + 'px';
    card.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
    // Override the FAB positioning for absolute card
    card.style.removeProperty('margin');
  } else {
    card.style.removeProperty('position');
    card.style.removeProperty('top');
    card.style.removeProperty('left');
  }

  card.style.display = 'flex';
}

export function hideSuggestion() {
  const card = document.getElementById('privexa-suggestion-card');
  if (card) card.style.display = 'none';
}

export function addChatMessage(role: 'user'|'bot', text: string) {
  const messages = document.getElementById('privexa-chat-messages');
  if (!messages) return;
  const msg = document.createElement('div');
  msg.className = `pvx-msg ${role}`;
  msg.textContent = text;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
}

export function enableChatInput() {
  const sendBtn = document.getElementById('privexa-chat-send') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = false;
}
