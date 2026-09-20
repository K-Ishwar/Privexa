import { chromium } from 'playwright';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = join(root, 'dist/chrome');

if (!fs.existsSync(extensionPath)) {
  console.error("❌ Extension not found! Please run 'npm run build' first.");
  process.exit(1);
}

const mockSitePath = 'file://' + join(root, 'tests/mock-site.html').replace(/\\/g, '/');

(async () => {
  console.log('🚀 Launching Privexa Visual E2E Demo...');
  
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    slowMo: 100,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1280,800'
    ]
  });

  // Close the default blank page and open a new one
  if (context.pages().length > 0) {
    await context.pages()[0].close();
  }
  const page = await context.newPage();
  
  console.log(`📂 Opening Mock Site: ${mockSitePath}`);
  await page.goto(mockSitePath);
  
  console.log('⏳ Waiting 3 seconds for you to see the initial state...');
  await page.waitForTimeout(3000);
  
  // Connect to the extension's Background Service Worker to send messages to the Content Script
  let [background] = context.serviceWorkers();
  if (!background) {
    background = await context.waitForEvent('serviceworker');
  }

  // Get the active tab ID
  const activeTabId = await background.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0].id;
  });

  console.log('🤖 Agent Scanning Page (Simulating Extension Popup)...');
  
  const scene = await background.evaluate(async (tabId) => {
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'PRIVEXA_SCAN', goal: 'NEXT_STEP', nlpEnabled: true }, (res) => {
        resolve(res.scene);
      });
    });
  }, activeTabId);
  
  if (scene) {
    console.log(`✅ Scan successful! Found ${scene.elements.length} elements.`);
  }

  console.log('⏳ Waiting 2 seconds...');
  await page.waitForTimeout(2000);

  console.log('✨ Shadow Agent Executing Action...');
  await background.evaluate(async ({tabId, scene}) => {
    const emptyInput = scene.elements.find(e => e.role === 'INPUT' && e.state === 'EMPTY');
    if (!emptyInput) return;
    
    const plan = {
      requestId: scene.requestId,
      revision: scene.revision,
      mode: 'DEMO',
      actions: [{ kind: 'FOCUS', target: emptyInput.id, amount: 0, reason: 'EMPTY_FIELD' }]
    };
    
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'PRIVEXA_EXECUTE', plan }, resolve);
    });
  }, {tabId: activeTabId, scene});

  console.log('🎉 Action executed! Watch the glowing UI on screen.');
  console.log('⏳ Waiting 6 seconds before closing...');
  await page.waitForTimeout(6000);
  
  console.log('👋 Demo complete! Closing browser.');
  await context.close();
})();
