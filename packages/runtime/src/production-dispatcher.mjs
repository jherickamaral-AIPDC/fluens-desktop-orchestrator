import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';

import { ProviderDispatcher } from '../vendor/engine/dispatcher.mjs';
import {
  IncrementalProviderTransport,
  buildAllowedEnvironment,
  claudeStreamJsonPlan,
  codexAppServerPlan
} from '../vendor/engine/provider-runner.mjs';
import { BridgeError } from '../vendor/bridge/util.mjs';

async function assertDedicatedCwd(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError('PROVIDER_CWD_INVALID');
  const entries = await readdir(directory);
  if (entries.length !== 0) throw new BridgeError('PROVIDER_CWD_NOT_EMPTY');
}

async function assertExecutableReadable(pin) {
  const info = await lstat(pin.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== pin.bytes) throw new BridgeError('PROVIDER_EXECUTABLE_INVALID');
  const handle = await open(pin.path, fsConstants.O_RDONLY);
  await handle.close();
}

function transportOptions(provider) {
  return {
    mode: provider === 'CODEX' ? 'PERSISTENT' : 'ONESHOT',
    cwd: null,
    env: null,
    timeoutMs: null,
    maximumLineBytes: 1048576,
    maximumStdoutBytes: 8388608,
    maximumStderrBytes: 1048576,
    maximumLines: 10000
  };
}

export async function createProductionDispatcherFactory(config) {
  return async ({ provider }) => {
    const selected = config.providers[provider];
    if (!selected?.enabled) throw new BridgeError('PROVIDER_DISABLED');
    const pin = Object.freeze({ path: selected.executable_path, bytes: selected.executable_bytes, sha256: selected.executable_sha256 });
    await assertDedicatedCwd(selected.cwd);
    await assertExecutableReadable(pin);
    const options = Object.freeze({
      ...transportOptions(provider),
      cwd: selected.cwd,
      env: buildAllowedEnvironment(process.env, selected.environment_allowlist),
      timeoutMs: selected.timeout_ms
    });
    const codexTransportFactory = () => {
      if (provider !== 'CODEX') throw new BridgeError('CODEX_SESSION_PROVIDER_INVALID');
      return new IncrementalProviderTransport(codexAppServerPlan(pin), options);
    };
    const claudeTransportFactory = (argv) => {
      if (provider !== 'CLAUDE') throw new BridgeError('CLAUDE_SESSION_PROVIDER_INVALID');
      return new IncrementalProviderTransport(claudeStreamJsonPlan(pin, argv), options);
    };
    const dispatcher = new ProviderDispatcher({
      codexTransportFactory,
      claudeTransportFactory,
      providerEffectsAuthorized: config.provider_effects_authorized
    });
    return Object.freeze({ dispatcher, postLifecycle: () => assertDedicatedCwd(selected.cwd) });
  };
}
