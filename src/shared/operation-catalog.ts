export interface OperationField {
  key: string;
  label: string;
  kind?: 'number' | 'multiline' | 'boolean';
  choices?: [string, string][];
  optional?: boolean;
}
export interface OperationDefinition {
  id: string;
  name: string;
  group: 'Midscene' | 'Playwright' | '录制操作' | '工作流';
  input: Record<string, unknown> | string;
  fields?: OperationField[];
}
const prompt: OperationField = { key: 'prompt', label: '目标或操作描述', kind: 'multiline' };
const timeout: OperationField = { key: 'timeoutMs', label: '最长等待（毫秒）', kind: 'number', optional: true };
const selector: OperationField = { key: 'selector', label: '元素选择器' };
const exact: OperationField = { key: 'exact', label: '精确匹配', kind: 'boolean' };
const value: OperationField = { key: 'value', label: '输入内容', kind: 'multiline' };
const direction: OperationField = { key: 'direction', label: '滚动方向', choices: [['down', '向下'], ['up', '向上'], ['left', '向左'], ['right', '向右']] };
export const operationCatalog: OperationDefinition[] = [
  ...Object.entries({ Tap: ['点击', { x: 0, y: 0 }], Input: ['输入文字', { value: '', mode: 'typeOnly' }], KeyboardPress: ['按键', { keyName: 'Enter' }], Scroll: ['滚动', { direction: 'down', distance: 500 }], DragAndDrop: ['拖拽', { x: 0, y: 0, endX: 100, endY: 100 }] } as const).map(([id, [name, payload]]) => ({ id, name, group: '录制操作' as const, input: { actionType: id, payload } })),
  ...Object.entries({ aiAct: 'AI 操作', aiTap: 'AI 点击', aiHover: 'AI 悬停', aiDoubleClick: 'AI 双击', aiRightClick: 'AI 右键点击', aiClearInput: 'AI 清空输入', aiLocate: 'AI 定位', aiAssert: 'AI 断言', aiBoolean: 'AI 提取布尔值', aiNumber: 'AI 提取数字', aiString: 'AI 提取文本', aiAsk: 'AI 问答' }).map(([id, name]) => ({ id, name, group: 'Midscene' as const, input: { prompt: '' }, fields: [prompt] })),
  { id: 'aiInput', name: 'AI 输入', group: 'Midscene', input: { prompt: '', value: '', mode: 'replace' }, fields: [prompt, value, { key: 'mode', label: '输入方式', choices: [['replace', '替换内容'], ['typeOnly', '继续输入'], ['clear', '清空内容']] }] },
  { id: 'aiKeyboardPress', name: 'AI 按键', group: 'Midscene', input: { keyName: 'Enter' }, fields: [{ ...prompt, optional: true }, { key: 'keyName', label: '按键' }] },
  { id: 'aiScroll', name: 'AI 滚动', group: 'Midscene', input: { direction: 'down', distance: 500 }, fields: [{ ...prompt, optional: true }, direction, { key: 'distance', label: '滚动距离', kind: 'number', optional: true }, { key: 'scrollType', label: '滚动方式', optional: true, choices: [['singleAction', '滚动指定距离'], ['scrollToTop', '滚动到顶部'], ['scrollToBottom', '滚动到底部'], ['scrollToLeft', '滚动到最左侧'], ['scrollToRight', '滚动到最右侧']] }] },
  { id: 'aiQuery', name: 'AI 提取结构化数据', group: 'Midscene', input: { dataDemand: '' }, fields: [{ key: 'dataDemand', label: '数据要求', kind: 'multiline' }] },
  { id: 'aiWaitFor', name: '等待条件', group: 'Midscene', input: { prompt: '', timeoutMs: 60000 }, fields: [{ ...prompt, label: '等待条件' }, timeout, { key: 'checkIntervalMs', label: '检查间隔（毫秒）', kind: 'number', optional: true }] },
  { id: 'recordToReport', name: '保存报告截图', group: 'Midscene', input: '当前页面' },
  { id: 'gotoUrl', name: '打开页面', group: 'Playwright', input: { url: '${baseUrl}' } },
  { id: 'click_by_text', name: '按文本点击', group: 'Playwright', input: { text: '', exact: true }, fields: [{ key: 'text', label: '目标文本' }, exact, timeout] },
  { id: 'click_by_role', name: '按角色点击', group: 'Playwright', input: { role: 'button', name: '', exact: true }, fields: [{ key: 'role', label: '元素角色' }, { key: 'name', label: '元素名称' }, exact, timeout] },
  { id: 'click_by_test_id', name: '按 test ID 点击', group: 'Playwright', input: { testId: '' }, fields: [{ key: 'testId', label: '测试标识' }, timeout] },
  ...Object.entries({ click: '点击元素', double_click: '双击元素', right_click: '右键点击元素', hover: '悬停元素', check: '勾选', uncheck: '取消勾选' }).map(([id, name]) => ({ id, name, group: 'Playwright' as const, input: { selector: '' }, fields: [selector, timeout] })),
  { id: 'fill', name: '填写输入框', group: 'Playwright', input: { selector: '', value: '' }, fields: [selector, value, timeout] },
  { id: 'press', name: '在元素上按键', group: 'Playwright', input: { selector: '', key: 'Enter' }, fields: [selector, { key: 'key', label: '按键' }, timeout] },
  { id: 'select_option', name: '选择下拉选项', group: 'Playwright', input: { selector: '', value: '' }, fields: [selector, { key: 'value', label: '选项值' }, timeout] },
  { id: 'drag_and_drop', name: '拖拽元素', group: 'Playwright', input: { selector: '', targetSelector: '' }, fields: [selector, { key: 'targetSelector', label: '终点选择器' }, timeout] },
  ...Object.entries({ reload: '刷新页面', goBack: '页面后退', goForward: '页面前进' }).map(([id, name]) => ({ id, name, group: 'Playwright' as const, input: {}, fields: [timeout] })),
  { id: 'setViewportSize', name: '设置视口', group: 'Playwright', input: { width: 1280, height: 800 } },
  { id: 'setCookies', name: '设置 Cookie', group: 'Playwright', input: { cookiesEnv: 'TEST_COOKIES' }, fields: [{ key: 'cookiesEnv', label: 'Cookie 环境变量名', optional: true }, { key: 'storageStatePath', label: '浏览器状态文件路径', optional: true }, { key: 'url', label: 'Cookie 地址', optional: true }] },
  { id: 'clearCookies', name: '清除 Cookie', group: 'Playwright', input: {}, fields: [{ key: 'name', label: 'Cookie 名称', optional: true }, { key: 'domain', label: 'Cookie 域名', optional: true }, { key: 'path', label: 'Cookie 路径', optional: true }] },
  { id: 'assertText', name: '检查可见文本', group: '工作流', input: { text: '', timeoutMs: 5000 } },
  { id: 'waitForElement', name: '等待元素', group: '工作流', input: { selector: '', state: 'visible', timeoutMs: 30000 } },
  { id: 'requireViewport', name: '准备视口', group: '工作流', input: { width: 1280, height: 800 } },
  { id: 'wait', name: '固定等待', group: '工作流', input: { duration: 1000, unit: 'ms' } },
];
export const operationGroups = ['Midscene', 'Playwright', '录制操作', '工作流'] as const;
export function operationId(step: Record<string, unknown>): string {
  const node = Object.keys(step).find(key => key !== '$' && key !== 'testo') ?? '';
  return node === 'recordedAction' ? String((step.recordedAction as Record<string, unknown>)?.actionType ?? node) : node;
}
export function createOperationStep(id: string): Record<string, unknown> {
  const definition = operationCatalog.find(item => item.id === id);
  if (!definition) throw new Error(`未知操作：${id}`);
  return { [definition.group === '录制操作' ? 'recordedAction' : id]: structuredClone(definition.input) };
}
