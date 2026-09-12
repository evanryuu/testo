export interface CheckTemplate {
  id: string;
  name: string;
  description: string;
  steps: Record<string, unknown>[];
}

/** Templates are editable starting points; the runner executes standard Midscene nodes. */
export const checkTemplates: readonly CheckTemplate[] = [
  {
    id: 'first-response', name: '等待首条回复',
    description: '等待最新提问下方出现回复正文，排除推理过程和旧会话内容。',
    steps: [{ aiWaitFor: { prompt: '最新一条用户消息下方出现非空的 AI 回复正文。推理过程、加载提示和之前的回复不算。', timeoutMs: 60000 }, testo: { name: '等待首条回复', metric: 'first-response' } }],
  },
  {
    id: 'response-complete', name: '等待回复完成',
    description: '等待生成结束后继续后续操作。请根据页面实际状态修改条件。',
    steps: [{ aiWaitFor: { prompt: '最新一条用户消息的 AI 回复正文已经显示，生成中的提示已经消失，停止生成按钮已经恢复为发送按钮。', timeoutMs: 120000 }, testo: { name: '等待回复完成', metric: 'response-complete' } }],
  },
  {
    id: 'stop-generation', name: '停止生成并检查',
    description: '先等待生成状态，点击停止按钮，再检查生成是否停止。',
    steps: [
      { aiWaitFor: { prompt: '当前回复正在生成，页面显示可点击的停止生成按钮。', timeoutMs: 60000 } },
      { aiTap: '当前回复的停止生成按钮' },
      { aiWaitFor: { prompt: '当前回复已经停止生成，停止生成按钮消失或恢复为发送按钮。', timeoutMs: 15000 } },
    ],
  },
  {
    id: 'citation-visible', name: '检查引用来源',
    description: '检查最新回复中是否展示来源链接。',
    steps: [{ aiAssert: '最新一条 AI 回复包含可见的引用来源，用户可以识别并点击来源链接。', testo: { name: '检查引用来源' } }],
  },
  {
    id: 'content-rule', name: '检查回复内容规则',
    description: '用自己的验收规则替换示例，避免只判断页面上有文字。',
    steps: [{ aiAssert: '最新一条 AI 回复回应了本次用户的问题。请将这里替换为具体业务规则，例如：回复包含日期、结论和来源。', testo: { name: '检查回复内容规则' } }],
  },
];
