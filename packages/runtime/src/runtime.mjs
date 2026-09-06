import { createBridgeServer } from '../vendor/bridge/server.mjs';
import { ProviderUiDriver } from './provider-driver.mjs';
import { createProductionDispatcherFactory } from './production-dispatcher.mjs';
import { validateRuntimeConfig } from './runtime-config.mjs';
import { POSTPUBLICATION_UI_PINS } from './ui-pins.mjs';

export async function createUiRuntime(rawConfig, options = {}) {
  const config = options.configAlreadyValidated === true ? rawConfig : validateRuntimeConfig(rawConfig);
  const dispatcherFactory = options.dispatcherFactory ?? await createProductionDispatcherFactory(config);
  const driver = options.driver ?? new ProviderUiDriver({ config, dispatcherFactory, pollIntervalMs: options.pollIntervalMs ?? 1 });
  const server = await createBridgeServer({
    host: config.host,
    port: config.port,
    uiRoot: config.ui_root,
    expectedUiPins: options.expectedUiPins ?? POSTPUBLICATION_UI_PINS,
    driver,
    requestTimeoutMs: config.request_timeout_ms,
    pollTimeoutMs: config.poll_timeout_ms,
    driverDrainTimeoutMs: config.driver_drain_timeout_ms,
    bodyReadTimeoutMs: config.body_read_timeout_ms,
    shutdownTimeoutMs: config.shutdown_timeout_ms,
    bootGeneration: options.bootGeneration
  });
  return Object.freeze({
    origin: server.origin,
    manager: server.manager,
    driver,
    start: () => server.start(),
    async stop() {
      await server.stop();
      await driver.shutdown();
    },
    address: () => server.address()
  });
}
