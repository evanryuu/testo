import { useEffect, useMemo, useState } from 'react';
import { Background, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { Project, TestGroup } from '../shared/workspace.js';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';

const GROUP_PAGE = 8, CASE_PAGE = 12;
type GraphData = { title: string; subtitle?: string; originalId?: string; selected?: boolean; expanded?: boolean; unavailable?: boolean; disabled?: boolean; expand?: () => void; toggle?: () => void; open?: () => void };
type GraphNode = Node<GraphData>;
function ProjectNode({ data }: NodeProps<GraphNode>) {
  return <div data-graph-node="project" className="w-48 rounded-xl border border-primary/30 bg-card p-4 shadow-sm"><strong className="block truncate text-sm">{data.title}</strong><p className="mt-2 text-xs text-muted-foreground">{data.subtitle}</p><Handle type="source" position={Position.Right} className="opacity-0" /></div>;
}
function GroupNode({ data }: NodeProps<GraphNode>) {
  return <div data-graph-node="group" data-group-id={data.originalId} className={`flex w-64 items-center gap-2 rounded-xl border bg-card p-3 shadow-sm ${data.expanded ? 'border-primary' : 'border-border'}`}>
    <Handle type="target" position={Position.Left} className="opacity-0" />
    <Button className="nodrag nopan h-auto min-w-0 flex-1 flex-col items-start gap-2 px-1 py-1 text-left" variant="ghost" aria-label={`${data.expanded ? '收起' : '展开'}分组 ${data.title}`} aria-expanded={data.expanded} onClick={data.expand}><strong className="w-full truncate text-sm">{data.title}</strong><span className="text-xs font-normal text-muted-foreground">{data.subtitle} · {data.expanded ? '收起' : '展开'}</span></Button>
    <Checkbox className="nodrag nopan" aria-label={`关系图选择分组 ${data.title}`} checked={data.selected} disabled={data.disabled} onCheckedChange={data.toggle} />
    <Handle type="source" position={Position.Right} className="opacity-0" />
  </div>;
}
function CaseNode({ data }: NodeProps<GraphNode>) {
  return <div data-graph-node="case" data-case-id={data.originalId} className="w-64 rounded-lg border bg-card p-2 shadow-sm"><Handle type="target" position={Position.Left} className="opacity-0" /><Button variant="ghost" className="nodrag nopan h-auto w-full justify-start whitespace-normal py-2 text-left text-xs" aria-label={`打开用例 ${data.title}`} disabled={data.unavailable} onClick={data.open}>{data.title}</Button></div>;
}
const nodeTypes = { project: ProjectNode, testGroup: GroupNode, case: CaseNode };
type Props = { project: Project; groups: TestGroup[]; selected: string[]; toggle(id: string): void; openCase(id: string): void; disabled?: boolean; search?: string };
function GraphCanvas({ project, groups, selected, toggle, openCase, disabled = false, search = '' }: Props) {
  const [groupPage, setGroupPage] = useState(0), [casePage, setCasePage] = useState(0);
  const [expanded, setExpanded] = useState(''), [zoom, setZoom] = useState(1);
  const flow = useReactFlow<GraphNode>(), initialized = useNodesInitialized();
  const cases = useMemo(() => new Map(project.cases.map(item => [item.id, item])), [project.cases]);
  const currentGroupPage = Math.min(groupPage, Math.max(0, Math.ceil(groups.length / GROUP_PAGE) - 1));
  const visible = groups.slice(currentGroupPage * GROUP_PAGE, (currentGroupPage + 1) * GROUP_PAGE);
  const group = visible.find(item => item.id === expanded);
  const query = search.toLowerCase();
  const memberIds = !group ? [] : !query || (group.name + ' ' + group.description).toLowerCase().includes(query) ? group.caseIds : group.caseIds.filter(id => {
    const item = cases.get(id); return item && (item.name + ' ' + item.tags.join(' ')).toLowerCase().includes(query);
  });
  const currentCasePage = Math.min(casePage, Math.max(0, Math.ceil(memberIds.length / CASE_PAGE) - 1));
  const members = memberIds.slice(currentCasePage * CASE_PAGE, (currentCasePage + 1) * CASE_PAGE);
  const height = Math.max(360, visible.length * 105, members.length * 75);
  const nodes: GraphNode[] = [
    { id: 'project', type: 'project', position: { x: 0, y: height / 2 - 42 }, data: { title: project.name, subtitle: groups.length + ' 个分组' } },
    ...visible.map((item, index): GraphNode => ({ id: 'group:' + item.id, type: 'testGroup', style: { pointerEvents: 'all' }, position: { x: 310, y: index * 105 }, data: {
      title: item.name, subtitle: item.caseIds.length + ' 个用例', originalId: item.id, selected: selected.includes(item.id), expanded: expanded === item.id, disabled,
      expand: () => { setExpanded(expanded === item.id ? '' : item.id); setCasePage(0); }, toggle: () => toggle(item.id),
    } })),
    ...members.map((id, index): GraphNode => ({ id: 'case:' + id, type: 'case', style: { pointerEvents: 'all' }, position: { x: 680, y: index * 75 }, data: { title: cases.get(id)?.name ?? '缺失用例：' + id, originalId: id, unavailable: !cases.has(id), open: () => { if (cases.has(id)) openCase(id); } } })),
  ];
  const edges: Edge[] = [
    ...visible.map(item => ({ id: 'project-' + item.id, source: 'project', target: 'group:' + item.id })),
    ...members.map(id => ({ id: 'member-' + id, source: 'group:' + group!.id, target: 'case:' + id })),
  ];
  const layoutKey = visible.map(item => item.id).join('|') + ':' + (group?.id ?? '') + ':' + members.join('|');
  useEffect(() => { if (initialized) void flow.fitView({ padding: 0.18, maxZoom: 1.1, duration: 0 }); }, [initialized, layoutKey, flow]);
  return <Card data-testid="group-graph"><CardContent className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">连线表示归属关系，不代表执行依赖。拖动画布平移，点击分组展开成员，点击用例查看详情。</p><div className="flex items-center gap-2"><Button size="icon-sm" variant="outline" aria-label="缩小关系图" disabled={zoom <= 0.2} onClick={() => void flow.zoomOut({ duration: 0 })}><Minus /></Button><span aria-label="关系图缩放比例" className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span><Button size="icon-sm" variant="outline" aria-label="放大关系图" disabled={zoom >= 2} onClick={() => void flow.zoomIn({ duration: 0 })}><Plus /></Button><Button size="icon-sm" variant="outline" aria-label="适应关系图" onClick={() => void flow.fitView({ padding: 0.18, maxZoom: 1.1, duration: 0 })}><Maximize /></Button></div></div>
    <div data-testid="group-graph-canvas" className="h-[560px] overflow-hidden rounded-lg border bg-muted/20">
      <ReactFlow<GraphNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.1 }} minZoom={0.2} maxZoom={2} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} onMove={(_event, viewport) => setZoom(viewport.zoom)} preventScrolling aria-label="项目分组用例关系图">
        <Background gap={24} size={1} />
      </ReactFlow>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><div className="flex items-center gap-2"><Button size="sm" variant="outline" aria-label="关系图上一页分组" disabled={currentGroupPage === 0} onClick={() => setGroupPage(currentGroupPage - 1)}>上一页分组</Button><span>{currentGroupPage + 1} / {Math.max(1, Math.ceil(groups.length / GROUP_PAGE))}</span><Button size="sm" variant="outline" aria-label="关系图下一页分组" disabled={(currentGroupPage + 1) * GROUP_PAGE >= groups.length} onClick={() => setGroupPage(currentGroupPage + 1)}>下一页分组</Button></div>{group ? <div className="flex items-center gap-2"><Button size="sm" variant="outline" aria-label="关系图上一页成员" disabled={currentCasePage === 0} onClick={() => setCasePage(currentCasePage - 1)}>上一页成员</Button><span>{currentCasePage + 1} / {Math.max(1, Math.ceil(memberIds.length / CASE_PAGE))} · {memberIds.length === group.caseIds.length ? `${memberIds.length} 个成员` : `${memberIds.length} / ${group.caseIds.length} 个匹配成员`}</span><Button size="sm" variant="outline" aria-label="关系图下一页成员" disabled={(currentCasePage + 1) * CASE_PAGE >= memberIds.length} onClick={() => setCasePage(currentCasePage + 1)}>下一页成员</Button></div> : null}</div>
    {!groups.length ? <p className="text-sm text-muted-foreground">没有匹配的分组。</p> : null}
  </CardContent></Card>;
}
export function GroupGraph(props: Props) { return <ReactFlowProvider><GraphCanvas {...props} /></ReactFlowProvider>; }
