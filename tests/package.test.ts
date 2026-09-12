import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { expect } from '@playwright/test';

const executable = process.env.TESTO_PACKAGE_EXECUTABLE || path.resolve('release/mac-arm64/Testo.app/Contents/MacOS/Testo');
test('packaged app runs, records, exports and restores data without source-tree assets', { timeout: 120000, skip: !existsSync(executable) }, async () => {
  mkdirSync('artifacts', {recursive:true});
  const directory = mkdtempSync(path.resolve('artifacts/package-'));
  const server = createServer((_req,res) => {res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<h1>Packaged Testo</h1><button style="position:absolute;left:20px;top:100px" onclick="this.textContent=\'Recorded\'">Send</button>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const baseUrl=`http://127.0.0.1:${address.port}`;
  const env = {...Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>x[1]!==undefined && x[0]!=='ELECTRON_RUN_AS_NODE')),WORKSPACE_DATA_DIR:path.join(directory,'data'),WORKSPACE_PROJECTS_DIR:path.join(directory,'projects')};
  let application: ElectronApplication|undefined;
  try {
    application=await electron.launch({executablePath:executable,env,timeout:30000});
    const page=await application.firstWindow();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.getByRole('button',{name:'新建项目',exact:true}).waitFor();
    await expect(page).toHaveTitle('Testo');
    await expect(page.getByRole('complementary')).toContainText('Testo');
    await expect(page.getByRole('complementary')).not.toContainText('Testing Workspace');
    if (process.platform === 'darwin') {
      const labels = await application.evaluate(({Menu}) => {
        const menu = Menu.getApplicationMenu()?.items[0];
        return [menu?.label, ...(menu?.submenu?.items.map(item => item.label) ?? [])];
      });
      assert.equal(labels[0], 'Testo');
      assert.ok(labels.includes('关于 Testo') && labels.includes('退出 Testo'));
      assert.ok(labels.every(label => !label?.includes('Testing Workspace')));
    }
    const ids=await page.evaluate(async baseUrl=>{
      const projectId=await window.workspace.createProject({name:'Package fixture',description:''});
      let project=(await window.workspace.state()).projects[0]!;
      const caseId=await window.workspace.createCase({projectId,name:'package',suiteId:project.suites[0]!.id,platforms:['web']});
      project=(await window.workspace.state()).projects[0]!;
      const workflowId=project.cases[0]!.workflows[0]!.id,environmentId=project.environments[0]!.id;
      await window.workspace.saveEnvironment({projectId,id:environmentId,name:'local',baseUrl});
      const workflow=await window.workspace.workflow({projectId,caseId,workflowId});
      await window.workspace.saveWorkflow({...workflow,projectId,caseId,workflowId,text:'cases:\n  - name: package\n    steps:\n      - gotoUrl: {url: "${baseUrl}"}\n      - assertText: {text: Packaged Testo}\nafterEach:\n  - recordToReport: package\n'});
      return {projectId,caseId,workflowId,environmentId};
    },baseUrl);
    const runId=await page.evaluate(ids=>window.workspace.run({...ids,browserMode:'isolated'}),ids);
    await expect.poll(() => page.evaluate(async runId=>(await window.workspace.runDetail({runId})).status,runId), {timeout:45000}).not.toBe('running');
    const result=await page.evaluate(runId=>window.workspace.runDetail({runId}),runId);
    assert.equal(result.status,'passed',JSON.stringify(result.result));assert.ok(result.result!.reportPaths.length);
    const file=path.join(directory,'package-report.zip');
    await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
    assert.equal(await page.evaluate(runId=>window.workspace.exportRun({runId}),runId),file);assert.ok(readFileSync(file).length>1000);
    assert.equal(await application.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable()),true,'macOS 系统凭证加密服务不可用，无法验证安装包的加密录制草稿');
    const recordingId=await page.evaluate(ids=>window.workspace.startRecording({...ids,browserMode:'isolated'}),ids);
    const frame=await page.evaluate(id=>window.workspace.recordingFrame({id}),recordingId);assert.ok(frame.previewUrl);assert.ok(frame.screenshot.startsWith('data:image/'));
    await page.evaluate(id=>window.workspace.recordingInteract({id,action:{actionType:'Tap',x:40,y:110}}),recordingId);
    await page.evaluate(id=>window.workspace.stopRecording({id}),recordingId);
    const state=await page.evaluate(()=>window.workspace.state());assert.ok(state.recording?.events.some(event=>event.actionType==='Tap'));
    assert.equal(state.recording?.chromeTarget,undefined);
    assert.match(readFileSync(path.join(directory,'data/recording-draft.json'),'utf8'),/^testo:encrypted:v1:/);
    const appInfo=await page.evaluate(()=>window.workspace.appInfo());assert.equal(appInfo.update.enabled,false);assert.equal(appInfo.dataDirectory,path.join(directory,'data'));
    await page.screenshot({path:path.join(directory,'packaged-app.png')});assert.deepEqual(errors,[]);
    await application.close(); application=await electron.launch({executablePath:executable,env,timeout:30000});
    const restored=await application.firstWindow();await restored.getByRole('button',{name:'新建项目',exact:true}).waitFor();
    const loaded=await restored.evaluate(()=>window.workspace.state());assert.equal(loaded.projects.length,1);assert.equal(loaded.runs[0]!.status,'passed');assert.ok(loaded.recording?.events.some(event=>event.actionType==='Tap'));
  } finally {
    if (application) {
      const child = application.process();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([application.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]);
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});
