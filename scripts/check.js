import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../', import.meta.url));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const directory of ['src', 'public', 'scripts', 'test']) {
  for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
    if (file.endsWith('.js')) run(['--check', `${directory}/${file}`]);
  }
}
run(['--test']);
run(['scripts/demo.js']);
