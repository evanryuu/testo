import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { parse } from 'yaml';

// A real Electron renderer with the production components and isolated data.
// The fixture owns callbacks only; field editing, YAML changes and validity are real.
test('Workflow editor edits native steps, preserves YAML, manages data and guards single-step debugging', { timeout: 90000 }, async () => {
  mkdirSync('artifacts', { recursive: true });
  const directory = mkdtempSync(path.resolve('artifacts/workflow-editor-ui-'));
  const workflow = `# retain this workflow comment\ncases:\n  - name: Knowledge base\n    steps:\n      - gotoUrl:\n          url: \${baseUrl}\n      # retain this input comment\n      - recordedAction:\n          actionType: Input\n          payload:\n            value: original\n            mode: replace\n            x: 20\n            y: 30\n          $:\n            timeout: 10000\n      - customNode:\n          nested:\n            keep: true\nafterEach:\n  - recordToReport: done\n`;
  writeFileSync(path.join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:1200,height:800,webPreferences:{contextIsolation:true,sandbox:true}});win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
  const styles = readdirSync(path.resolve('dist-ui/assets')).filter(file => file.endsWith('.css')).map(file => `<link rel="stylesheet" href="${pathToFileURL(path.resolve('dist-ui/assets', file)).href}">`).join('');
  writeFileSync(path.join(directory, 'index.html'), `<html><head>${styles}</head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`);
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{WorkflowEditor}from'./src/renderer/WorkflowEditor';
    import{ProjectAssetsView}from'./src/renderer/ProjectAssetsView';
    function Fixture(){const[text,setText]=useState(${JSON.stringify(workflow)}),[valid,setValid]=useState(true),[view,setView]=useState('workflow'),[revision,setRevision]=useState('r1'),[tick,setTick]=useState(0);window.fixtureText=text;window.fixtureValid=valid;
      return <main style={{maxWidth:1050,margin:'auto',padding:24}}><button onClick={()=>setView(view==='workflow'?'assets':'workflow')}>切换测试页面</button><button onClick={()=>setTick(tick+1)}>刷新测试状态</button><button onClick={()=>setRevision('external')}>模拟外部修改</button>{view==='workflow'?<><WorkflowEditor text={text} onChange={setText} onValidityChange={setValid} onDebug={input=>window.fixtureDebug=input} onRecord={(position,deleteCount)=>window.fixtureRecord={position,deleteCount}} flows={{shared:{name:'共享导航',steps:[{gotoUrl:{url:'\${baseUrl}'}}]}}}/><button disabled={!valid} onClick={()=>window.fixtureSaved=text}>保存工作流</button></>:<ProjectAssetsView variables={{}} flows={{}} revision={revision} onSave={value=>{window.fixtureAssets=value;setRevision('r2');return{revision:'r2'};}}/>}</main>;
    }createRoot(document.getElementById('root')).render(<Fixture/>);` }, outfile: path.join(directory, 'fixture.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias: { '@': path.resolve('src/renderer') }, logLevel: 'silent' });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [path.join(directory, 'main.cjs')], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE')) });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const source = () => page.evaluate(() => (window as any).fixtureText as string);
    await page.getByLabel('输入内容 2', { exact: true }).fill('${knowledgeBaseName}');
    await page.getByLabel('步骤名称 2', { exact: true }).fill('填写知识库名称');
    let document = parse(await source());
    assert.equal(document.cases[0].steps[1].recordedAction.payload.value, '${knowledgeBaseName}');
    assert.deepEqual(document.cases[0].steps[1].recordedAction.$, { timeout: 10000 });
    assert.deepEqual(document.cases[0].steps[2], { customNode: { nested: { keep: true } } });
    assert.match(await source(), /# retain this workflow comment/); assert.match(await source(), /# retain this input comment/);

    await page.getByRole('button', { name: '复制步骤 2', exact: true }).click();
    await expect(page.getByTestId('workflow-step')).toHaveCount(4);
    await page.getByRole('button', { name: '下移步骤 2', exact: true }).click();
    await page.getByLabel('启用步骤 3', { exact: true }).uncheck();
    assert.equal(parse(await source()).cases[0].steps[2].testo.disabled, true);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assert.notEqual(parse(await source()).cases[0].steps[2].testo.disabled, true);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(parse(await source()).cases[0].steps[2].testo.disabled, true);
    await page.getByRole('button', { name: '删除步骤 3', exact: true }).click();

    await page.getByRole('button', { name: '只运行步骤 2', exact: true }).isDisabled().then(value => assert.equal(value, true));
    await page.getByLabel('单步调试的前置条件', { exact: true }).fill('新建知识库弹窗已打开');
    await page.getByRole('button', { name: '只运行步骤 2', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).fixtureDebug), { mode: 'single-step', stepIndex: 1, precondition: '新建知识库弹窗已打开' });
    await page.getByRole('button', { name: '重录步骤 2', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).fixtureRecord), { position: 1, deleteCount: 1 });

    await page.getByLabel('编辑阶段', { exact: true }).selectOption('beforeEach');
    await page.getByLabel('新增步骤类型', { exact: true }).selectOption('flow:shared');
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
    await expect.poll(async () => parse(await source()).beforeEach).toEqual([{ useFlow: { id: 'shared' } }]);
    await page.getByLabel('编辑阶段', { exact: true }).selectOption('steps');
    await page.getByLabel('AI 检查模板', { exact: true }).selectOption('response-complete');
    await page.getByRole('button', { name: '添加模板', exact: true }).click();
    await page.getByLabel('最长等待（毫秒） 4', { exact: true }).fill('20000');
    await expect(page.getByLabel('最长等待（毫秒） 4', { exact: true })).toHaveValue('20000');
    assert.equal(parse(await source()).cases[0].steps[3].aiWaitFor.timeoutMs, 20000);

    await page.getByRole('tab', { name: '变量与数据集', exact: true }).click();
    const variables = page.getByRole('region', { name: '用例默认变量', exact: true });
    await variables.getByRole('button', { name: '添加变量', exact: true }).click();
    await page.getByLabel('用例默认变量名称 1', { exact: true }).fill('knowledgeBaseName');
    await page.getByLabel('用例默认变量值 1', { exact: true }).fill('每日测试知识库');
    assert.equal(parse(await source()).testo.variables.knowledgeBaseName, '每日测试知识库');
    await page.getByLabel('用例默认变量名称 1', { exact: true }).fill('baseUrl');
    await expect(page.getByRole('button', { name: '保存工作流', exact: true })).toBeDisabled();
    await page.getByLabel('用例默认变量名称 1', { exact: true }).fill('knowledgeBaseName');
    await expect(page.getByRole('button', { name: '保存工作流', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '添加数据集', exact: true }).click();
    await page.getByLabel('数据集名称 1', { exact: true }).fill('中文名称');
    const dataset = page.getByRole('region', { name: '数据集 1 变量', exact: true });
    await dataset.getByRole('button', { name: '添加变量', exact: true }).click();
    await page.getByLabel('数据集 1 变量名称 1', { exact: true }).fill('knowledgeBaseName');
    await page.getByLabel('数据集 1 变量值 1', { exact: true }).fill('中文数据集');
    assert.equal(parse(await source()).testo.datasets[0].variables.knowledgeBaseName, '中文数据集');
    await page.getByRole('tab', { name: 'YAML', exact: true }).click();
    await expect(page.getByLabel('Workflow YAML', { exact: true })).toHaveValue(await source());
    await page.screenshot({ path: path.join(directory, 'workflow-yaml.png') });

    await page.getByRole('button', { name: '切换测试页面', exact: true }).click();
    await page.getByRole('button', { name: '新建共享步骤', exact: true }).click();
    await page.getByLabel('共享步骤名称', { exact: true }).fill('进入知识库页面');
    await page.getByRole('button', { name: '刷新测试状态', exact: true }).click();
    await expect(page.getByLabel('共享步骤名称', { exact: true })).toHaveValue('进入知识库页面');
    await expect(page.getByRole('tab', { name: '变量与数据集', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('编辑阶段', { exact: true })).toHaveCount(0);
    await page.getByLabel('新增步骤类型', { exact: true }).selectOption('gotoUrl');
    await page.getByRole('button', { name: '添加步骤', exact: true }).click();
    await page.getByRole('button', { name: '保存项目资产', exact: true }).click();
    const saved: any = await page.evaluate(() => (window as any).fixtureAssets);
    assert.equal(saved.revision, 'r1');
    assert.equal(Object.values(saved.flows).length, 1);
    assert.deepEqual(Object.values(saved.flows)[0], { name: '进入知识库页面', steps: [{ gotoUrl: { url: '${baseUrl}' } }] });
    await page.screenshot({ path: path.join(directory, 'shared-flow.png') });
    await page.getByRole('button', { name: '保存项目资产', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).fixtureAssets.revision), 'r2');
    await page.getByRole('button', { name: '模拟外部修改', exact: true }).click();
    await expect(page.getByRole('button', { name: '保存项目资产', exact: true })).toBeDisabled();
    await expect(page.getByLabel('共享步骤名称', { exact: true })).toHaveValue('进入知识库页面');
    await page.getByRole('button', { name: '载入最新项目资产', exact: true }).click();
    await expect(page.getByLabel('共享步骤名称', { exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally { await app?.close(); }
});
