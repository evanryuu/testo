import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeNodes } from '../src/runner/bridge-nodes.js';

const baseUrl = 'https://example.test';
test('Bridge navigation finishes at DOMContentLoaded even while resources are loading', async () => {
  const calls: string[] = [];
  const agent = { interface: {
    navigate: async () => { throw new Error('legacy complete wait must not run'); },
    sendCommandToDebugger: async (method: string) => {
      calls.push(method);
      if (method === 'Page.navigate') return { frameId: 'root', loaderId: 'new' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', loaderId: calls.includes('Page.navigate') ? 'new' : 'old', url: baseUrl + '/next' } } };
      if (method === 'Runtime.evaluate') return { result: { value: { href: baseUrl + '/next', domReady: true, loaded: false } } };
      return {};
    },
  } } as unknown as Parameters<typeof createBridgeNodes>[0] extends () => infer T ? T : never;
  const node = createBridgeNodes(() => agent, baseUrl)[0]!;
  await node.execute({ input: { url: '/next', timeoutMs: 1000 }, signal: new AbortController().signal } as any);
  assert.ok(calls.includes('Runtime.evaluate'));
});


test('an unrelated replacement document cannot satisfy the requested navigation', async () => {
  let navigated = false, stopped = false;
  const agent = { interface: { sendCommandToDebugger: async (method: string) => {
    if (method === 'Page.navigate') { navigated = true; return { frameId: 'root', loaderId: 'requested' }; }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', loaderId: navigated ? 'unrelated' : 'old', url: 'https://other.test/' } } };
    if (method === 'Runtime.evaluate') throw new Error('must not inspect unrelated document');
    if (method === 'Page.stopLoading') stopped = true;
    return {};
  } } } as any;
  const node = createBridgeNodes(() => agent, baseUrl)[0]!;
  await assert.rejects(async () => node.execute({ input: { url: '/next', timeoutMs: 50 }, signal: new AbortController().signal } as any), /导航超时/);
  assert.equal(stopped, true);
});

test('old loaded document is ignored until the requested document finishes DOMContentLoaded', async () => {
  let probes = 0, navigated = false;
  const agent = { interface: { sendCommandToDebugger: async (method: string) => {
    if (method === 'Page.navigate') { navigated = true; return { frameId: 'root', loaderId: 'new' }; }
    if (method === 'Page.getFrameTree') { probes++; return { frameTree: { frame: { id: 'root', loaderId: navigated && probes > 2 ? 'new' : 'old', url: baseUrl + '/next' } } }; }
    if (method === 'Runtime.evaluate') { assert.ok(probes > 2); return { result: { value: { href: baseUrl + '/next', domReady: true, loaded: false } } }; }
    return {};
  } } } as any;
  await createBridgeNodes(() => agent, baseUrl)[0]!.execute({ input: { url: '/next', timeoutMs: 1000 }, signal: new AbortController().signal } as any);
  assert.ok(probes >= 3);
});
