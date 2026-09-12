import type { RecordedTarget } from './recording.js';
export type { RecordedTarget } from './recording.js';
// This function executes in the target document, not in the application renderer.
export function inspectRecordedTarget(point: { x?: number; y?: number }): RecordedTarget | null {
  const hit = point.x !== undefined && point.y !== undefined ? document.elementFromPoint(point.x, point.y) : document.activeElement;
  if (!hit) return null;
  const el = hit.closest('button,input,textarea,select,a,[role],[contenteditable="true"]') ?? hit;
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type')?.toLowerCase();
  const implicit = tag === 'button' ? 'button' : tag === 'a' && el.hasAttribute('href') ? 'link' : tag === 'textarea' || el.getAttribute('contenteditable') === 'true' ? 'textbox' : tag === 'select' ? 'combobox' : tag === 'input' ? type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : ['button', 'submit', 'reset'].includes(type ?? '') ? 'button' : 'textbox' : undefined;
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  const labels = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? [...(el.labels ?? [])].map(label => label.textContent).join(' ').trim() : undefined;
  const role = el.getAttribute('role') || implicit;
  const name = (el.getAttribute('aria-label') || labelled || labels || el.getAttribute('placeholder') || (role === 'button' || role === 'link' ? el.textContent : '') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const testId = el.getAttribute('data-testid');
  return { tag, ...(role ? { role } : {}), ...(name ? { name } : {}), ...(testId ? { testId } : {}) };
}
export function targetMismatch(expected: RecordedTarget, actual: RecordedTarget | null): string | undefined {
  if (!actual) return '录制坐标处没有目标元素';
  const mismatched = (['tag', 'role', 'name', 'testId'] as const).filter(key => expected[key] !== undefined && expected[key] !== actual[key]);
  if (!mismatched.length) return;
  return `录制目标不匹配（${mismatched.map(key => `${key}: 预期 ${JSON.stringify(expected[key])}，实际 ${JSON.stringify(actual[key] ?? '')}`).join('；')}）。未执行操作，请检查页面状态，重新定位后更新此步骤`;
}
