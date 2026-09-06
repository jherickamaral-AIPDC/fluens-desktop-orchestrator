import path from 'node:path';

import { assertExactKeys, BridgeError, isPlainObject, isSafeId } from '../vendor/bridge/util.mjs';
import { isSha256 } from '../vendor/engine/util.mjs';

export const PROVIDERS = Object.freeze(['CODEX', 'CLAUDE']);

const TOP_KEYS = Object.freeze([
  'schema', 'host', 'port', 'ui_root', 'provider_effects_authorized',
  'default_provider', 'agent_provider_map', 'providers',
  'request_timeout_ms', 'poll_timeout_ms', 'driver_drain_timeout_ms',
  'body_read_timeout_ms', 'shutdown_timeout_ms'
]);
const PROVIDER_KEYS = Object.freeze([
  'enabled', 'executable_path', 'executable_bytes', 'executable_sha256',
  'cwd', 'environment_allowlist', 'timeout_ms'
]);

function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BridgeError(code);
  return value;
}

function validateProvider(name, value, effectsAuthorized) {
  assertExactKeys(value, PROVIDER_KEYS, `${name}_CONFIG_KEYS_INVALID`);
  if (typeof value.enabled !== 'boolean') throw new BridgeError(`${name}_ENABLED_INVALID`);
  boundedInteger(value.timeout_ms, 100, 300000, `${name}_TIMEOUT_INVALID`);
  if (!Array.isArray(value.environment_allowlist) || value.environment_allowlist.length > 32 ||
      new Set(value.environment_allowlist).size !== value.environment_allowlist.length ||
      value.environment_allowlist.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(entry))) {
    throw new BridgeError(`${name}_ENVIRONMENT_ALLOWLIST_INVALID`);
  }
  if (!value.enabled) {
    if (value.executable_path !== null || value.executable_bytes !== 0 || value.executable_sha256 !== null ||
        value.cwd !== null || value.environment_allowlist.length !== 0) throw new BridgeError(`${name}_DISABLED_CONFIG_INVALID`);
    return Object.freeze({ ...value, environment_allowlist: Object.freeze([]) });
  }
  if (!effectsAuthorized) throw new BridgeError('PROVIDER_EFFECTS_NOT_AUTHORIZED');
  if (typeof value.executable_path !== 'string' || !path.isAbsolute(value.executable_path) || value.executable_path.includes('\0') ||
      !Number.isSafeInteger(value.executable_bytes) || value.executable_bytes < 1 || !isSha256(value.executable_sha256) ||
      typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || value.cwd.includes('\0')) {
    throw new BridgeError(`${name}_RUNTIME_IDENTITY_INVALID`);
  }
  return Object.freeze({ ...value, environment_allowlist: Object.freeze([...value.environment_allowlist]) });
}

export function validateRuntimeConfig(value) {
  assertExactKeys(value, TOP_KEYS, 'RUNTIME_CONFIG_KEYS_INVALID');
  if (value.schema !== 'FLUENS_UI_RUNTIME_CONFIG_V1' || value.host !== '127.0.0.1' ||
      typeof value.provider_effects_authorized !== 'boolean' || !PROVIDERS.includes(value.default_provider) ||
      typeof value.ui_root !== 'string' || value.ui_root.length < 1 || value.ui_root.includes('\0')) {
    throw new BridgeError('RUNTIME_CONFIG_VALUE_INVALID');
  }
  boundedInteger(value.port, 1024, 65535, 'RUNTIME_PORT_INVALID');
  boundedInteger(value.request_timeout_ms, 100, 300000, 'RUNTIME_REQUEST_TIMEOUT_INVALID');
  boundedInteger(value.poll_timeout_ms, 10, 5000, 'RUNTIME_POLL_TIMEOUT_INVALID');
  boundedInteger(value.driver_drain_timeout_ms, 10, 5000, 'RUNTIME_DRIVER_DRAIN_TIMEOUT_INVALID');
  boundedInteger(value.body_read_timeout_ms, 10, 5000, 'RUNTIME_BODY_TIMEOUT_INVALID');
  boundedInteger(value.shutdown_timeout_ms, 100, 10000, 'RUNTIME_SHUTDOWN_TIMEOUT_INVALID');
  if (!isPlainObject(value.agent_provider_map) || Object.keys(value.agent_provider_map).length > 64) throw new BridgeError('AGENT_PROVIDER_MAP_INVALID');
  const routes = {};
  for (const [agentId, provider] of Object.entries(value.agent_provider_map)) {
    if (!isSafeId(agentId, 96) || !PROVIDERS.includes(provider)) throw new BridgeError('AGENT_PROVIDER_ROUTE_INVALID');
    routes[agentId] = provider;
  }
  assertExactKeys(value.providers, PROVIDERS, 'PROVIDERS_CONFIG_KEYS_INVALID');
  const providers = {
    CODEX: validateProvider('CODEX', value.providers.CODEX, value.provider_effects_authorized),
    CLAUDE: validateProvider('CLAUDE', value.providers.CLAUDE, value.provider_effects_authorized)
  };
  return Object.freeze({
    ...value,
    ui_root: path.resolve(value.ui_root),
    agent_provider_map: Object.freeze(routes),
    providers: Object.freeze(providers)
  });
}
