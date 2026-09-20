import { PrivexaMode } from './page-analyser.js';

class ModeManager {
  private currentMode: PrivexaMode = 'LATENCY';
  private listeners: ((mode: PrivexaMode) => void)[] = [];

  constructor() {
    this.loadState();
  }

  private async loadState() {
    // In a real extension, we would use chrome.storage.local
    // For now, we keep it in memory/session
    const stored = localStorage.getItem('privexa_mode');
    if (stored === 'LATENCY' || stored === 'BALANCED' || stored === 'ACCURACY') {
      this.currentMode = stored;
    }
  }

  getMode(): PrivexaMode {
    return this.currentMode;
  }

  setMode(mode: PrivexaMode) {
    if (this.currentMode !== mode) {
      this.currentMode = mode;
      localStorage.setItem('privexa_mode', mode);
      this.notifyListeners();
      this.broadcastToContentScript();
    }
  }

  subscribe(callback: (mode: PrivexaMode) => void) {
    this.listeners.push(callback);
    callback(this.currentMode); // notify immediately
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      listener(this.currentMode);
    }
  }

  private async broadcastToContentScript() {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'PRIVEXA_MODE_CHANGED',
            mode: this.currentMode
          }).catch(() => {
            // Ignore error if content script isn't injected yet
          });
        }
      } catch (err) {
        console.warn('Could not broadcast mode change:', err);
      }
    }
  }
}

export const modeManager = new ModeManager();
