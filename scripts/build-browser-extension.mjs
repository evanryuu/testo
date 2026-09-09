import { build } from 'esbuild';
import stdlib from 'node-stdlib-browser';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), output = path.join(root, 'dist-browser-extension');
await mkdir(path.join(output, 'scripts'), { recursive: true });
const browser = { bundle: true, platform: 'browser', format: 'iife', target: 'chrome120',
  alias: Object.fromEntries(Object.entries({ ...stdlib, 'node:fs/promises': stdlib.fs, 'fs/promises': stdlib.fs }).map(([key, value]) => [key, value.replace('/esm/mock/empty.js', '/cjs/mock/empty.js')])),
  inject: [path.join(root, 'node_modules/node-stdlib-browser/helpers/esbuild/shim.js')],
};
await build({ ...browser, entryPoints: ['browser-extension/background.js'], outfile: path.join(output, 'background.js') });
await build({ ...browser, entryPoints: ['node_modules/@midscene/shared/dist/es/extractor/index.mjs'], globalName: 'midscene_element_inspector', outfile: path.join(output, 'scripts/htmlElement.js') });
for (const file of ['manifest.json', 'options.html', 'options.css', 'options.js', 'THIRD_PARTY_NOTICES.md', 'LICENSE.midscene']) await copyFile(path.join('browser-extension', file), path.join(output, file));
await copyFile('browser-extension/stop-water-flow.js', path.join(output, 'scripts/stop-water-flow.js'));
console.log('Chrome connector built: ' + output);
