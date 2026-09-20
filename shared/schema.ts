/** Strict, wire-safe schema for Privexa Local.  This module intentionally has no
 * browser or server dependencies so both ends can use the same checks. */

export const GOALS = ['REVIEW_FORM', 'NEXT_STEP', 'SCROLL_DOWN'] as const;
export type Goal = (typeof GOALS)[number];

export const LABELS = [
  '[PERSON_NAME]', '[EMAIL]', '[PHONE]', '[AADHAAR]', '[PAN]', '[PASSWORD]',
  '[ADDRESS]', '[PAYMENT]', '[PRIVATE_TEXT]', '[IMAGE]', '[PERSON_IMAGE]',
  '[TEXT_IN_IMAGE]', '[UNKNOWN_VISUAL]', 'NAME', 'EMAIL', 'PHONE', 'ADDRESS',
  'PASSWORD', 'AADHAAR', 'PAN', 'SEARCH', 'SUBMIT', 'CONTINUE', 'NEXT', 'BACK',
  'CANCEL', 'SAVE', 'REVIEW', 'CHECKBOX', 'SELECT', 'FIELD', 'TEXT',
] as const;
export type Label = (typeof LABELS)[number];

export const ROLES = ['INPUT', 'BUTTON', 'LINK', 'TEXT', 'IMAGE', 'SELECT', 'CHECKBOX'] as const;
export type Role = (typeof ROLES)[number];
export const ELEMENT_STATES = ['EMPTY', 'FILLED', 'AVAILABLE', 'DISABLED'] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export type Box = { x: number; y: number; width: number; height: number };
export type VisionRegion = {
  label: '[PERSON_IMAGE]' | '[IMAGE]' | '[TEXT_IN_IMAGE]' | '[UNKNOWN_VISUAL]';
  box: Box;
};
export type Vision = {
  status: 'NOT_RUN' | 'READY' | 'UNAVAILABLE';
  backend: 'NONE' | 'WASM' | 'GPU';
  durationMs: number;
  regions: VisionRegion[];
};
export type Element = {
  id: string;
  role: Role;
  label: Label;
  state: ElementState;
  box: Box;
  rawText?: string;
};
export type Scene = {
  version: '1.0';
  requestId: string;
  revision: string;
  goal: Goal;
  viewport: { width: number; height: number };
  elements: Element[];
  vision: Vision;
  privacy: { mode: 'SEMANTIC_ONLY' | 'HYBRID'; rawPixels: false; freeText: boolean; redactedPixels: string | null };
};

export const ACTION_KINDS = ['FOCUS', 'FILL', 'CLICK', 'SCROLL', 'DONE'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_REASONS = ['EMPTY_FIELD', 'NEXT_CONTROL', 'USER_SCROLL', 'REVIEW_REQUIRED', 'NO_SAFE_ACTION'] as const;
export type ActionReason = (typeof ACTION_REASONS)[number];

/** Tokens the server is allowed to put in a FILL action's value field.
 *  The real value is looked up from the local encrypted vault — never sent over the network. */
export const VAULT_TOKENS = ['{{NAME}}', '{{EMAIL}}', '{{PHONE}}', '{{ADDRESS}}', '{{AADHAAR}}', '{{PAN}}', '{{PASSWORD}}'] as const;
export type VaultToken = (typeof VAULT_TOKENS)[number];
export const VAULT_TOKEN_RE = /^\{\{[A-Z_]+\}\}$/;

export type Action = {
  kind: ActionKind;
  target: string | null;
  targetCoordinate?: Box | null;
  amount: number;
  reason: ActionReason;
  /** Only present on FILL actions. Contains a {{TOKEN}} placeholder — never a real value. */
  value?: VaultToken | null;
};
export type Plan = { requestId: string; revision: string; mode: 'DEMO' | 'OLLAMA' | 'GEMINI' | 'OPENAI' | 'GROQ'; actions: Action[] };

// Canonical lowercase UUID spelling. Version/variant bits are not constrained so
// interoperability with UUID libraries (including nil UUID fixtures) is retained.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_CLICK_LABELS = new Set<Label>(['CONTINUE', 'NEXT', 'REVIEW', 'BACK', 'CANCEL']);
const VISION_LABELS = new Set<VisionRegion['label']>(['[PERSON_IMAGE]', '[IMAGE]', '[TEXT_IN_IMAGE]', '[UNKNOWN_VISUAL]']);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function record(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid object');
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error('invalid object');
  // Never permit inherited fields to participate in validation.
  return v as Record<string, unknown>;
}
function exact(o: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  for (const k of Object.keys(o)) if (!expected.has(k)) throw new Error('unknown field: ' + k);
  for (const k of keys) if (!hasOwn(o, k)) throw new Error('missing field: ' + k);
}
function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw new Error('invalid enum');
  return v as T;
}
function uuid(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error('invalid uuid');
  return v;
}
function int(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) throw new Error('invalid integer');
  return v;
}
function num(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error('invalid number');
  return v;
}
function box(v: unknown, maxWidth: number, maxHeight: number): Box {
  const o = record(v); exact(o, ['x', 'y', 'width', 'height']);
  const x = int(o.x, 0, 10000), y = int(o.y, 0, 10000);
  const width = int(o.width, 0, 10000), height = int(o.height, 0, 10000);
  if (x + width > maxWidth || y + height > maxHeight) throw new Error('box outside viewport');
  return { x, y, width, height };
}
function label(v: unknown): Label { return oneOf(v, LABELS); }
function sameBox(a: Box, b: Box): boolean { return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height; }

export function validateScene(value: unknown): Scene {
  const o = record(value); exact(o, ['version', 'requestId', 'revision', 'goal', 'viewport', 'elements', 'vision', 'privacy']);
  if (o.version !== '1.0') throw new Error('invalid version');
  const requestId = uuid(o.requestId), revision = uuid(o.revision);
  const goal = oneOf(o.goal, GOALS);
  const vp = record(o.viewport); exact(vp, ['width', 'height']);
  const width = int(vp.width, 1, 10000), height = int(vp.height, 1, 10000);
  if (!Array.isArray(o.elements) || o.elements.length > 200) throw new Error('invalid elements');
  const ids = new Set<string>();
  const elements: Element[] = [];
  for (const raw of o.elements) {
    const e = record(raw);
    if (hasOwn(e, 'rawText')) {
      exact(e, ['id', 'role', 'label', 'state', 'box', 'rawText']);
    } else {
      exact(e, ['id', 'role', 'label', 'state', 'box']);
    }
    const id = uuid(e.id); if (ids.has(id)) throw new Error('duplicate element'); ids.add(id);
    let rawText: string | undefined;
    if (e.rawText !== undefined) { if (typeof e.rawText !== 'string') throw new Error('invalid rawText'); rawText = e.rawText; }
    elements.push({ id, role: oneOf(e.role, ROLES), label: label(e.label), state: oneOf(e.state, ELEMENT_STATES), box: box(e.box, width, height), rawText });
  }
  const vo = record(o.vision); exact(vo, ['status', 'backend', 'durationMs', 'regions']);
  const status = oneOf(vo.status, ['NOT_RUN', 'READY', 'UNAVAILABLE'] as const);
  const backend = oneOf(vo.backend, ['NONE', 'WASM', 'GPU'] as const);
  const durationMs = num(vo.durationMs, 0, 120000);
  if (!Array.isArray(vo.regions) || vo.regions.length > 100) throw new Error('invalid regions');
  const regions: VisionRegion[] = [];
  for (const raw of vo.regions) {
    const r = record(raw); exact(r, ['label', 'box']);
    regions.push({ label: oneOf(r.label, [...VISION_LABELS] as VisionRegion['label'][]), box: box(r.box, width, height) });
  }
  if (status === 'NOT_RUN' && (backend !== 'NONE' || durationMs !== 0 || regions.length !== 0)) throw new Error('inconsistent vision');
  if (status === 'READY' && backend === 'NONE') throw new Error('inconsistent vision');
  if (status === 'UNAVAILABLE' && regions.length !== 0) throw new Error('inconsistent vision');
  const p = record(o.privacy); exact(p, ['mode', 'rawPixels', 'freeText', 'redactedPixels']);
  if (p.mode !== 'SEMANTIC_ONLY' && p.mode !== 'HYBRID') throw new Error('invalid privacy');
  if (p.rawPixels !== false || typeof p.freeText !== 'boolean') throw new Error('invalid privacy');
  if (p.redactedPixels !== null && typeof p.redactedPixels !== 'string') throw new Error('invalid privacy');
  return { version: '1.0', requestId, revision, goal, viewport: { width, height }, elements, vision: { status, backend, durationMs, regions }, privacy: { mode: p.mode as 'SEMANTIC_ONLY' | 'HYBRID', rawPixels: false, freeText: p.freeText as boolean, redactedPixels: p.redactedPixels as string | null } };
}

export function validatePlan(value: unknown, scene: Scene): Plan {
  // Validate the scene too when called with a boundary object, while retaining the
  // identity needed for revision/request matching.
  const safeScene = validateScene(scene);
  const o = record(value); exact(o, ['requestId', 'revision', 'mode', 'actions']);
  const requestId = uuid(o.requestId), revision = uuid(o.revision);
  if (requestId !== safeScene.requestId || revision !== safeScene.revision) throw new Error('stale plan');
  const mode = oneOf(o.mode, ['DEMO', 'OLLAMA', 'GEMINI', 'OPENAI', 'GROQ'] as const);
  if (!Array.isArray(o.actions) || o.actions.length === 0) throw new Error('at least one action required');
  const parsedActions: Action[] = [];
  for (const raw of o.actions) {
    const ao = record(raw);
    // Allow optional 'value' field on FILL actions (not present on other kinds)
    const actionKeys = ['kind', 'target', 'targetCoordinate', 'amount', 'reason'];
    if (hasOwn(ao, 'value')) actionKeys.push('value');
    if (hasOwn(ao, 'resolvedValue')) actionKeys.push('resolvedValue');
    exact(ao, actionKeys);
    const kind = oneOf(ao.kind, ACTION_KINDS), reason = oneOf(ao.reason, ACTION_REASONS);
    let target: string | null;
    if (ao.target === null) target = null; else target = uuid(ao.target);
    let targetCoordinate: Box | null = null;
    if (hasOwn(ao, 'targetCoordinate') && ao.targetCoordinate !== null) targetCoordinate = box(ao.targetCoordinate, safeScene.viewport.width, safeScene.viewport.height);
    const amount = int(ao.amount, -800, 800);
    let actionValue: VaultToken | null = null;
    if (kind === 'SCROLL') {
      if (target !== null || (reason !== 'USER_SCROLL' && reason !== 'NEXT_CONTROL') || amount === 0) throw new Error('invalid scroll');
    } else if (kind === 'DONE') {
      if (target !== null || amount !== 0 || (reason !== 'NO_SAFE_ACTION' && reason !== 'REVIEW_REQUIRED')) throw new Error('invalid done');
    } else if (kind === 'FILL') {
      if (target === null || amount !== 0) throw new Error('invalid fill target');
      const targetElement = safeScene.elements.find((e) => e.id === target);
      if (!targetElement || targetElement.state === 'DISABLED') throw new Error('invalid target');
      if (!['INPUT', 'SELECT'].includes(targetElement.role)) throw new Error('fill only on input/select');
      if (reason !== 'EMPTY_FIELD' && reason !== 'NEXT_CONTROL') throw new Error('invalid fill reason');
      // Validate the vault token — must be a known {{TOKEN}} placeholder
      if (!hasOwn(ao, 'value') || ao.value === null || typeof ao.value !== 'string' || !VAULT_TOKEN_RE.test(ao.value as string)) throw new Error('invalid fill value token');
      if (!(VAULT_TOKENS as readonly string[]).includes(ao.value as string)) throw new Error('unknown vault token');
      actionValue = ao.value as VaultToken;
    } else {
      if (target === null || amount !== 0) throw new Error('invalid target action');
      const targetElement = safeScene.elements.find((e) => e.id === target);
      if (!targetElement || targetElement.state === 'DISABLED') throw new Error('invalid target');
      if (kind === 'FOCUS') {
        if (!['INPUT', 'SELECT', 'CHECKBOX'].includes(targetElement.role) || (targetElement.state !== 'EMPTY' && targetElement.state !== 'FILLED') || (reason !== 'EMPTY_FIELD' && reason !== 'NEXT_CONTROL')) throw new Error('incompatible focus');
      } else {
        if (targetElement.role !== 'BUTTON' || targetElement.state !== 'AVAILABLE' || !SAFE_CLICK_LABELS.has(targetElement.label) || (reason !== 'NEXT_CONTROL' && reason !== 'REVIEW_REQUIRED')) throw new Error('unsafe click');
      }
    }
    const action: Action = { kind, target, targetCoordinate, amount, reason };
    if (actionValue !== null) action.value = actionValue;
    if (hasOwn(ao, 'resolvedValue')) (action as any).resolvedValue = ao.resolvedValue;
    parsedActions.push(action);
  }
  return { requestId, revision, mode, actions: parsedActions };
}

export function isSameElement(a: Element, b: Element): boolean {
  return a.id === b.id && a.role === b.role && a.label === b.label && a.state === b.state;
}
