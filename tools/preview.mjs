import { fileURLToPath, pathToFileURL } from 'node:url';
import { createUiRuntime } from '../packages/runtime/src/runtime.mjs';

export function previewConfig(port = 8787) {
  const disabled = () => ({ enabled: false, executable_path: null, executable_bytes: 0,
    executable_sha256: null, cwd: null, environment_allowlist: [], timeout_ms: 30000 });
  return {
    schema: 'FLUENS_UI_RUNTIME_CONFIG_V1', host: '127.0.0.1', port,
    ui_root: fileURLToPath(new URL('../apps/ui/', import.meta.url)),
    provider_effects_authorized: false, default_provider: 'CODEX', agent_provider_map: {},
    providers: { CODEX: disabled(), CLAUDE: disabled() },
    request_timeout_ms: 30000, poll_timeout_ms: 250, driver_drain_timeout_ms: 1000,
    body_read_timeout_ms: 1000, shutdown_timeout_ms: 5000
  };
}

export async function createPreview(port = 8787) {
  return createUiRuntime(previewConfig(port));
}

async function main() {
  if (process.argv.length !== 2) throw new Error('PREVIEW_ARGUMENTS_INVALID');
  const runtime = await createPreview();
  await runtime.start();
  console.log('Fluens preview: ' + runtime.origin);
  console.log('Proveedores deshabilitados. Usa contenido sintético y un navegador vacío. Ctrl+C para salir.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await runtime.stop(); process.exitCode = 0; }
    catch { process.exitCode = 1; console.error('PREVIEW_STOP_FAILED'); }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('PREVIEW_START_FAILED'); process.exitCode = 1; });
}
