import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { ClaudeStreamJsonAdapter } from '../vendor/engine/adapters.mjs';
import { ProviderDispatcher } from '../vendor/engine/dispatcher.mjs';
import { BoundedNdjsonFramer, IncrementalProviderTransport, buildAllowedEnvironment } from '../vendor/engine/provider-runner.mjs';
import { sha256Bytes, sha256Text } from '../vendor/engine/util.mjs';
import { ProviderUiDriver } from '../src/provider-driver.mjs';
import { DeterministicClaudeOfficialPeer } from './support/engine-mocks.mjs';

function petition(id = 'petition_safety_0001') {
  return { peticionId: id, agenteId: 'agent_safety_0001', chatId: 'chat_safety_0001', instruccionBase: 'bounded', bloques: [], mensajes: [], recorte: { aplicado: false, mensajesOmitidos: 0 } };
}

const CONFIG = Object.freeze({ default_provider: 'CODEX', agent_provider_map: {}, providers: { CODEX: { enabled: true }, CLAUDE: { enabled: true } } });

class FakeChild extends EventEmitter {
  constructor({ backpressure = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.closed = false;
    if (backpressure) {
      this.stdin = new EventEmitter();
      this.stdin.write = () => false;
      this.stdin.end = () => {};
    } else this.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  }
  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end(); this.stderr.end();
    queueMicrotask(() => this.emit('close', code, signal));
  }
  kill(signal = 'SIGTERM') { this.killed = true; this.close(null, signal); return true; }
}

async function withMockExecutable(action) {
  const root = await mkdtemp(path.join(tmpdir(), 'uiruntime-transport-'));
  try {
    const executable = path.join(root, 'provider.bin');
    const bytes = Buffer.from('bounded-provider-fixture');
    await writeFile(executable, bytes, { flag: 'wx' });
    return await action(root, { path: executable, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function transport(pin, root, child, overrides = {}) {
  return new IncrementalProviderTransport({ pin, argv: ['mock'] }, {
    mode: 'PERSISTENT', cwd: root, env: {}, timeoutMs: 200,
    maximumLineBytes: 128, maximumStdoutBytes: 256, maximumStderrBytes: 64,
    maximumLines: 10, processFactory: () => child, ...overrides
  });
}

test('C07 strict incremental framing rejects replay, unknown/malformed, oversize, truncation and excess total', () => {
  const adapter = new ClaudeStreamJsonAdapter();
  adapter.beginReview('bounded review', null);
  const messages = new DeterministicClaudeOfficialPeer().messages();
  const init = messages[0];
  adapter.receive(init);
  adapter.receive(messages[1]);
  assert.throws(() => adapter.receive(messages[1]), /REPLAY/);
  const framer = new BoundedNdjsonFramer({ maximumLineBytes: 32, maximumTotalBytes: 64, maximumLines: 2 });
  assert.equal(framer.push(Buffer.from('{"id":1}\n')).length, 1);
  assert.throws(() => framer.push(Buffer.from(`{"x":"${'x'.repeat(40)}"}\n`)), /OVERSIZE/);
  const truncated = new BoundedNdjsonFramer({ maximumLineBytes: 100, maximumTotalBytes: 100, maximumLines: 2 });
  truncated.push(Buffer.from('{"id":'));
  assert.throws(() => truncated.finish(), /TRUNCATED/);
  const total = new BoundedNdjsonFramer({ maximumLineBytes: 100, maximumTotalBytes: 8, maximumLines: 2 });
  assert.throws(() => total.push(Buffer.from('{"id":1}\n')), /TOTAL_OVERSIZE/);
});

test('C09 incremental timeout cancels and drains without a real process', async () => withMockExecutable(async (root, pin) => {
  const child = new FakeChild();
  const instance = transport(pin, root, child, { timeoutMs: 20 });
  await instance.start({ onMessage: async () => {}, onExit: async () => {}, onError: async () => {}, isComplete: () => false });
  await assert.rejects(instance.completion(), /PROVIDER_TIMEOUT/);
  assert.equal(child.killed, true);
  assert.equal(instance.isDrained(), true);
}));

test('C09 stdin backpressure settles on cancel with zero pending writes', async () => withMockExecutable(async (root, pin) => {
  const child = new FakeChild({ backpressure: true });
  const instance = transport(pin, root, child);
  await instance.start({ onMessage: async () => {}, onExit: async () => {}, onError: async () => {}, isComplete: () => false });
  const pending = instance.writeObject({ type: 'bounded' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(instance.memorySummary().pending_writes, 1);
  assert.equal(instance.cancel(), true);
  await assert.rejects(pending, /CANCELLED|TERMINATED/);
  await instance.completion();
  assert.equal(instance.memorySummary().pending_writes, 0);
  assert.equal(instance.isDrained(), true);
}));

test('C09 incomplete drain remains globally fail-closed and blocks cross-provider replacement', async () => {
  class IncompleteTransport {
    constructor() { this.handlers = null; this.closed = false; this.done = new Promise((resolve) => { this.resolve = resolve; }); }
    async start(handlers) { this.handlers = handlers; }
    async writeObject() {}
    shutdown() {
      if (this.closed) return false;
      this.closed = true;
      const summary = { exit_code: 0, stdout: { total_bytes: 0, line_count: 0 }, stderr: { bytes: 0, sha256: sha256Text('') }, cancelled: true };
      queueMicrotask(async () => { await this.handlers.onExit(summary); this.resolve(summary); });
      return true;
    }
    cancel() { return this.shutdown(); }
    completion() { return this.done; }
    isDrained() { return false; }
  }
  const codexFactory = () => new IncompleteTransport();
  const claudeFactory = () => new IncompleteTransport();
  codexFactory.mock = true; claudeFactory.mock = true;
  const dispatcher = new ProviderDispatcher({ codexTransportFactory: codexFactory, claudeTransportFactory: claudeFactory });
  await dispatcher.dispatchCodex('task_incomplete_runtime_0001', 'bounded');
  await assert.rejects(dispatcher.cancel('task_incomplete_runtime_0001'), /PROVIDER_DRAIN_INCOMPLETE/);
  assert.equal(dispatcher.memorySummary().lifecycle, 'DRAINING');
  await assert.rejects(dispatcher.dispatchClaude('task_cross_runtime_0001', 'blocked'), /PROVIDER_TURN_ALREADY_ACTIVE/);
});

test('C03/C09 driver admits exactly one active turn and cancellation settles exactly once', async () => {
  let cancels = 0;
  const dispatcher = {
    active: true,
    taskId: null,
    async dispatchCodex(taskId) { this.taskId = taskId; },
    poll() { return []; },
    memorySummary() { return { lifecycle: this.active ? 'ACTIVE' : 'IDLE', active_task_id: this.active ? this.taskId : null, draining: false }; },
    async cancel() { cancels += 1; this.active = false; },
    async shutdown() { this.active = false; }
  };
  const factory = async () => ({ dispatcher });
  const driver = new ProviderUiDriver({ config: CONFIG, dispatcherFactory: factory });
  const controller = new AbortController();
  const sink = { token: () => true, finish: () => {}, fail: () => {} };
  const first = driver.run(petition(), sink, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(driver.run(petition('petition_safety_0002'), sink, new AbortController().signal), /PROVIDER_TURN_ALREADY_ACTIVE/);
  controller.abort();
  await first;
  assert.equal(cancels, 1);
  assert.equal(driver.memorySummary().lifecycle, 'IDLE');
});

test('C07 unknown provider event fails closed with a bounded public code', async () => {
  let emitted = false;
  const dispatcher = {
    async dispatchCodex() {},
    poll() { if (emitted) return []; emitted = true; return [{ event: 'INVENTED_PROVIDER_EVENT' }]; },
    memorySummary() { return { lifecycle: 'IDLE', active_task_id: null, draining: false }; },
    async shutdown() {}
  };
  const driver = new ProviderUiDriver({ config: CONFIG, dispatcherFactory: async () => ({ dispatcher }) });
  let code = null;
  await driver.run(petition(), { token: () => true, finish: () => {}, fail: (value) => { code = value; } }, new AbortController().signal);
  assert.equal(code, 'PROVIDER_EVENT_UNKNOWN');
});

test('B4 provider driver preserves only a safe bounded inner protocol code', async () => {
  for (const [inner, expected] of [['CODEX_INITIALIZE_RESULT_INVALID', 'CODEX_INITIALIZE_RESULT_INVALID'], ['raw path C:\\private', 'PROVIDER_TRANSPORT_ERROR']]) {
    let emitted = false;
    const dispatcher = {
      async dispatchCodex(taskId) { this.taskId = taskId; },
      poll() { if (emitted) return []; emitted = true; return [{ event: 'TRANSPORT_ERROR', error_code: inner }]; },
      memorySummary() { return { lifecycle: 'IDLE', active_task_id: null, draining: false }; },
      async cancel() {},
      async shutdown() {}
    };
    const driver = new ProviderUiDriver({ config: CONFIG, dispatcherFactory: async () => ({ dispatcher }) });
    let code = null;
    await driver.run(petition(`petition_b4_${emitted}`), { token: () => true, finish: () => false, fail: (value) => { code = value; return true; } }, new AbortController().signal);
    assert.equal(code, expected);
  }
});

test('C10 child environment is a closed allowlist and secret names are forbidden', () => {
  assert.deepEqual({ ...buildAllowedEnvironment({ PATH: 'safe', LANG: 'C', OPENAI_API_KEY: 'forbidden' }, ['PATH', 'LANG']) }, { PATH: 'safe', LANG: 'C' });
  assert.throws(() => buildAllowedEnvironment({ OPENAI_API_KEY: 'forbidden' }, ['OPENAI_API_KEY']), /ENVIRONMENT_NAME_FORBIDDEN/);
});
