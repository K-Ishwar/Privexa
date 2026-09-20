import { validatePlan } from './shared/schema.ts';

const safe = {
  version: '1.0',
  requestId: '11111111-1111-1111-1111-111111111111',
  revision: '11111111-1111-1111-1111-111111111111',
  goal: 'NEXT_STEP',
  viewport: { width: 800, height: 600 },
  elements: [
    { id: '11111111-1111-1111-1111-111111111111', role: 'INPUT', label: '[PERSON_NAME]', state: 'EMPTY', box: { x: 0, y: 0, width: 100, height: 20 } }
  ],
  vision: { status: 'NOT_RUN', backend: 'NONE', durationMs: 0, regions: [] },
  privacy: { mode: 'SEMANTIC_ONLY', rawPixels: false, freeText: false, redactedPixels: null }
};

const action1 = {
  kind: 'FILL', target: '11111111-1111-1111-1111-111111111111', amount: 0, reason: 'EMPTY_FIELD', value: '{{NAME}}'
};

const plan1 = validatePlan({
  requestId: safe.requestId,
  revision: safe.revision,
  mode: 'GROQ',
  actions: [action1]
}, safe as any);

const action2 = plan1.actions[0];
console.log(action2);
(action2 as any).resolvedValue = 'John Doe';

try {
  validatePlan({
    requestId: safe.requestId,
    revision: safe.revision,
    mode: 'GROQ',
    actions: [action2]
  }, safe as any);
  console.log("SUCCESS!");
} catch(e: any) {
  console.error("FAIL:", e.message);
}
