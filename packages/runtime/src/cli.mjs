import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeStrictUtf8, parseStrictJson } from '../vendor/bridge/strict-json.mjs';
import { errorCode } from '../vendor/bridge/util.mjs';
import { createUiRuntime } from './runtime.mjs';

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('CLI_ARGUMENTS_INVALID');
  const configPath = path.resolve(process.argv[3]);
  const bytes = await readFile(configPath);
  const config = parseStrictJson(decodeStrictUtf8(bytes, 65536), { maximumBytes: 65536, maximumDepth: 12, maximumNodes: 4096 });
  const runtime = await createUiRuntime(config);
  await runtime.start();
  process.stdout.write(`UI_RUNTIME_READY=${runtime.origin}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.stop();
  };
  process.once('SIGINT', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)); });
}

main().catch((error) => {
  process.stderr.write(`${errorCode(error)}\n`);
  process.exitCode = 1;
});
