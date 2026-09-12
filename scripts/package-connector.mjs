import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipPassThrough } from 'fflate';
import { once } from 'node:events';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('release', { recursive: true });
const file = `release/Testo-Connector-${version}.zip`, output = createWriteStream(file);
let failure;
output.on('error', error => { failure = error; });
const zip = new Zip((error, data, final) => { if (error) { failure = error; output.destroy(error); } else { output.write(data); if (final) output.end(); } });
async function add(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await add(source, name);
    else if (entry.isFile()) {
      const member = new ZipPassThrough(name); zip.add(member);
      for await (const chunk of createReadStream(source)) { if (failure) throw failure; member.push(chunk); if (output.writableNeedDrain) await once(output, 'drain'); }
      member.push(new Uint8Array(), true);
    } else throw new Error(`Unsupported extension entry: ${source}`);
  }
}
await add('dist-browser-extension');
zip.end();
await once(output, 'finish');
console.log(`${file} (${(await stat(file)).size} bytes)`);
