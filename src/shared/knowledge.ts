import { z } from 'zod/v4';

const nonempty = (max: number) => z.string().max(max).refine(value => value.trim().length > 0, '不能为空');
export const knowledgeEntrySchema = z.strictObject({
  id: nonempty(128),
  title: nonempty(200),
  aliases: z.array(nonempty(200)).max(20),
  content: nonempty(12000),
  status: z.enum(['draft', 'confirmed']),
  source: z.enum(['manual', 'ai']),
  updatedAt: z.iso.datetime({ offset: true }),
  sourceCaseId: nonempty(128).optional(),
  sourceWorkflowId: nonempty(128).optional(),
});
const entriesSchema = z.array(knowledgeEntrySchema).max(500).refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, '知识条目 ID 不能重复');
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;
export interface KnowledgeSnapshot { revision: string; entries: KnowledgeEntry[] }
export interface SaveKnowledgeInput { revision: string; entries: KnowledgeEntry[] }
export function validateKnowledgeEntries(value: unknown): KnowledgeEntry[] {
  const result = entriesSchema.safeParse(value);
  if (!result.success) throw new Error(`知识库格式无效：${result.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`);
  return result.data;
}
