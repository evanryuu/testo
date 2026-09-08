import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Recorder verification</title><style>body{background:#f6f8fc;color:#183052;font:18px system-ui;margin:0}h1{position:absolute;left:64px;top:25px;font-size:25px}input{box-sizing:border-box;position:absolute;left:64px;top:110px;width:320px;height:44px;padding:10px;border:1px solid #ccd7e7;border-radius:8px;font-size:16px}button{position:absolute;left:404px;top:110px;width:120px;height:44px;background:#3479f4;color:white;border:0;border-radius:8px;font-size:16px}#result{position:absolute;left:64px;top:185px;color:#25815c}input[type=range]{appearance:none;margin:0;padding:0;border:0;background:transparent}input[type=range]::-webkit-slider-runnable-track{height:8px;background:#ccd7e7;border-radius:4px}input[type=range]::-webkit-slider-thumb{appearance:none;width:32px;height:32px;margin-top:-12px;border-radius:50%;background:#3479f4}footer{position:absolute;left:64px;top:700px;color:#8596ab;font-size:14px}</style></head><body><h1>Testing Workspace · 录制演示</h1><input aria-label="消息" placeholder="输入测试消息"><button>发送</button><div id="result">等待发送消息</div><input type="range" min="0" max="100" value="0" style="top:270px" oninput="if(this.value>60)document.getElementById('drag-result').textContent='滑动完成'"><div id="drag-result" style="position:absolute;left:64px;top:330px"></div><footer>本地测试页面 · 不调用外部服务</footer><script>document.querySelector('button').onclick=async()=>{const message=document.querySelector('input').value;await fetch('/submit',{method:'POST',body:message});document.querySelector('#result').textContent='发送成功：'+message;setTimeout(()=>history.pushState({},'', '/conversation/recorded'),1200);};</script></body></html>`;

const official = (page: Page) => page.frameLocator('iframe[title="Midscene 官方录制预览"]');
async function clickPreview(page: Page, x: number, y: number) {
  const box = await official(page).locator('.screenshot-image').boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + x * box.width / 1280, box.y + y * box.height / 800);
}
async function waitPreview(page: Page) {
  await official(page).locator('[data-midscene-device-interaction-layer]').waitFor({ timeout: 50_000 });
  await official(page).locator('.screenshot-image').waitFor();
}

test('record in Workspace, review, save YAML, replay the real form and recover a recording draft', { timeout: 180_000 }, async () => {
  const root = process.cwd(); mkdirSync('artifacts', { recursive: true });
  const data = mkdtempSync(path.resolve('artifacts/recording-ui-'));
  const submissions: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/submit') { let text = ''; req.on('data', (chunk) => text += chunk); req.on('end', () => { submissions.push(text); res.end('ok'); }); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'ELECTRON_RUN_AS_NODE' && !e[0].startsWith('MIDSCENE_MODEL'))), WORKSPACE_DATA_DIR: path.join(data, 'app'), WORKSPACE_PROJECTS_DIR: path.join(data, 'projects') };
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({ args: [root], env });
    let page = await application.firstWindow(); page.setDefaultTimeout(12_000);
    const uiErrors: string[] = []; page.on('pageerror', (e) => uiErrors.push(e.message));
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('录制 MVP 验证');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: '新建用例', exact: true }).first().click();
    await page.getByLabel('用例名称', { exact: true }).fill('未登录用户发送消息');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: 'Environments', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('Web 地址', { exact: true }).fill(baseUrl);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('button', { name: /^Test Cases/ }).click();
    await page.getByRole('button', { name: /未登录用户发送消息/ }).click();
    await page.getByRole('button', { name: '开始录制', exact: true }).click();
    await waitPreview(page);
    await page.getByText('● 录制中', { exact: true }).waitFor();
    await page.getByLabel('录制网页地址', { exact: true }).fill(`${baseUrl}/chat`);
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.getByText('正在处理操作', { exact: true }).waitFor({ state: 'hidden' });
    const previewUrl = await page.locator('iframe[title="Midscene 官方录制预览"]').getAttribute('src');
    assert.ok(previewUrl);
    assert.equal((await fetch(previewUrl + '/status')).status, 403, 'other local clients must not access the recorder');
    const imageBox = await official(page).locator('.screenshot-image').boundingBox(); assert.ok(imageBox);
    await page.mouse.move(imageBox.x + imageBox.width * .8, imageBox.y + imageBox.height * .5);
    await page.mouse.wheel(0, 320);
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.some((e) => e.actionType === 'Scroll'))).toBeTruthy();
    await page.mouse.wheel(0, -320);
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.filter((e) => e.actionType === 'Scroll').length >= 2)).toBeTruthy();
    await clickPreview(page, 150, 132);
    await page.keyboard.type('temporary');
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('Hello from Workspace');
    // Dispatch browser composition/paste events to the actual official input sink.
    // Device input, collection and replay are real; no OS clipboard or IME settings are changed.
    const sink = official(page).locator('[data-midscene-keyboard-sink]');
    await sink.evaluate((element) => {
      const data = new DataTransfer(); data.setData('text/plain', ' 中文粘贴');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: ' 输入法' }));
    });
    await clickPreview(page, 455, 132);
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.some((e) => e.actionType === 'Input'))).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const tick = () => submissions.length ? resolve() : Date.now() > deadline ? reject(new Error('No real form submission')) : setTimeout(tick, 50);
      tick();
    });
    assert.deepEqual(submissions, ['Hello from Workspace 中文粘贴 输入法']);
    // A delayed SPA navigation must arrive without any further preview interaction.
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.some((e) => e.rawPayload?.implicitNavigationState === true && String(e.url).endsWith('/conversation/recorded')))).toBeTruthy();
    await page.getByText('地址变化 ' + baseUrl + '/conversation/recorded', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.workspace.state())).recording!.events.filter((e) => e.rawPayload?.implicitNavigationState === true && String(e.url).endsWith('/conversation/recorded')).length, 1);
    const dragBox = await official(page).locator('.screenshot-image').boundingBox(); assert.ok(dragBox);
    await page.mouse.move(dragBox.x + 80 * dragBox.width / 1280, dragBox.y + 292 * dragBox.height / 800);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + 340 * dragBox.width / 1280, dragBox.y + 292 * dragBox.height / 800, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(async () => (await window.workspace.state()).recording!.events.some((e) => e.actionType === 'DragAndDrop'))).toBeTruthy();
    await page.locator('[data-action-type="DragAndDrop"]').waitFor();
    await page.locator('.recording-heading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(root, 'artifacts/recording-live.png') });
    // Backend rejects execution while the recorder owns the browser session.
    const concurrent = await page.evaluate(async () => {
      const s = await window.workspace.state(), d = s.recording!;
      try { await window.workspace.run({ projectId: d.projectId, caseId: d.caseId, workflowId: d.workflowId, environmentId: d.environmentId }); }
      catch (e) { return String(e); }
      return '';
    });
    assert.match(concurrent, /先停止录制/);
    await page.getByRole('button', { name: '停止录制并检查', exact: true }).click();
    await page.getByRole('button', { name: '添加断言', exact: true }).waitFor();
    const stopped = await page.evaluate(() => window.workspace.state());
    assert.equal(stopped.recording?.status, 'review');
    assert.ok(stopped.recording!.events.some((e) => e.actionType === 'InitialNavigation'));
    const tap = stopped.recording!.events.find((e) => e.actionType === 'Tap')!;
    assert.equal(tap.source, 'studio-preview');
    assert.ok(tap.screenshotAsset);
    const image = await page.evaluate(({ id, hashId }) => window.workspace.recordingScreenshot({ id, hashId }), { id: stopped.recording!.id, hashId: tap.hashId });
    assert.match(image, /^data:image\/(png|jpeg);base64,/);
    await page.locator(`[data-recorder-event="${tap.hashId}"]`).getByRole('button', { name: /截图/ }).click();
    await page.getByRole('img', { name: '录制事件截图', exact: true }).waitFor();
    await page.waitForFunction(() => (document.querySelector('[role="dialog"] img') as HTMLImageElement)?.naturalWidth > 0);
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: path.join(root, 'artifacts/recording-event-screenshot.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.ok(stopped.recording!.events.filter((e) => e.actionType === 'Tap').length >= 2);
    await page.getByRole('button', { name: '添加断言', exact: true }).click();
    await page.getByLabel('断言 1 内容', { exact: true }).fill('发送成功：Hello from Workspace 中文粘贴 输入法');
    await page.getByRole('button', { name: '添加断言', exact: true }).click();
    await page.getByLabel('断言 2 内容', { exact: true }).fill('滑动完成');
    await page.getByRole('button', { name: '预览 YAML', exact: true }).click();
    const yaml = await page.getByLabel('生成的 Workflow YAML').innerText();
    assert.match(yaml, /recordedAction/); assert.match(yaml, /assertText/);
    assert.doesNotMatch(yaml, /conversation\/recorded/, 'implicit navigation must not become gotoUrl');
    await page.screenshot({ path: path.join(root, 'artifacts/recording-review.png'), fullPage: true });
    await page.getByRole('button', { name: '保存到当前用例', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).click();
    await page.locator('[data-testid="run-summary"] [data-status="passed"]').waitFor({ timeout: 50_000 });
    assert.deepEqual(submissions, ['Hello from Workspace 中文粘贴 输入法', 'Hello from Workspace 中文粘贴 输入法']);
    await page.screenshot({ path: path.join(root, 'artifacts/recording-replay.png') });
    const state = await page.evaluate(() => window.workspace.state());
    assert.ok(state.runs[0]!.result!.reportPaths.length > 0);
    assert.match(readFileSync(path.join(state.projects[0]!.root, 'workspace.yaml'), 'utf8'), /录制 MVP/);
    await page.getByRole('button', { name: '返回用例再运行' }).click();
    await page.getByRole('button', { name: '开始录制', exact: true }).click();
    await waitPreview(page);
    await page.getByText('● 录制中', { exact: true }).waitFor();
    await clickPreview(page, 150, 132);
    await page.keyboard.type('last input before stop');
    await page.getByRole('button', { name: '停止录制并检查', exact: true }).click();
    await page.getByRole('button', { name: '添加断言', exact: true }).waitFor();
    assert.ok((await page.evaluate(() => window.workspace.state())).recording!.events.some((e) => String(e.rawPayload?.value).includes('last input before stop')));
    await page.getByLabel('第 1 步执行方式', { exact: true }).selectOption('ai');
    await page.getByLabel('第 1 步 AI 描述', { exact: true }).fill('点击消息输入框');
    await page.getByRole('button', { name: '添加断言', exact: true }).click();
    await page.getByLabel('断言 1 内容', { exact: true }).fill('草稿断言需要保留');
    const project = state.projects[0]!, item = project.cases[0]!;
    const workflowFile = path.join(project.root, project.suites[0]!.directory, item.id, item.workflows[0]!.definitionPath);
    const externalEdit = readFileSync(workflowFile, 'utf8') + '\n# External edit must survive recording save\n';
    writeFileSync(workflowFile, externalEdit);
    const beforeRestart = (await page.evaluate(() => window.workspace.state())).recording!;
    const screenshotEvent = beforeRestart.events.find((e) => e.screenshotAsset)!;
    const beforeImage = await page.evaluate(({ id, hashId }) => window.workspace.recordingScreenshot({ id, hashId }), { id: beforeRestart.id, hashId: screenshotEvent.hashId });
    await application.close();
    application = await electron.launch({ args: [root], env });
    page = await application.firstWindow();
    await page.getByRole('button', { name: '打开录制', exact: true }).click();
    await page.getByRole('img', { name: '录制网页预览' }).waitFor();
    assert.equal(await page.evaluate(({ id, hashId }) => window.workspace.recordingScreenshot({ id, hashId }), { id: beforeRestart.id, hashId: screenshotEvent.hashId }), beforeImage);
    await page.getByLabel('第 1 步执行方式', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('第 1 步 AI 描述', { exact: true }).inputValue(), '点击消息输入框');
    assert.equal(await page.getByLabel('断言 1 内容', { exact: true }).inputValue(), '草稿断言需要保留');
    await page.getByRole('button', { name: '保存到当前用例', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /外部修改/ }).waitFor();
    assert.equal(readFileSync(workflowFile, 'utf8'), externalEdit);
    await page.getByRole('button', { name: '放弃本次录制', exact: true }).click();
    await page.getByRole('button', { name: '确认放弃', exact: true }).click();
    await page.getByRole('button', { name: '运行', exact: true }).waitFor();
    const restored = await page.evaluate(() => window.workspace.state());
    assert.equal(restored.recording, undefined);
    assert.equal(restored.runs[0]!.status, 'passed');
    assert.equal(uiErrors.length, 0, uiErrors.join('\n'));
    console.log(`Recording verification data: ${data}`);
  } catch (error) {
    const page = application?.windows()[0];
    if (page && !page.isClosed()) { console.log((await page.locator('body').innerText()).slice(-6000)); await page.screenshot({ path: 'artifacts/recording-failure.png' }); }
    throw error;
  } finally { await application?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
