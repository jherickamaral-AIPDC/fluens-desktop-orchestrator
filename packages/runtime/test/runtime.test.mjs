import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderDispatcher } from '../vendor/engine/dispatcher.mjs';
import { ProviderUiDriver } from '../src/provider-driver.mjs';
import { buildDeterministicPrompt, selectProvider } from '../src/prompt.mjs';
import {
  DeterministicClaudeOfficialPeer,
  DeterministicCodexOfficialPeer,
  InMemoryClaudeOfficialTransport,
  InMemoryCodexOfficialTransport
} from './support/engine-mocks.mjs';

function petition(overrides = {}) {
  return {
    peticionId: 'petition_runtime_0001',
    agenteId: 'agent_default_0001',
    chatId: 'chat_runtime_0001',
    instruccionBase: 'Explain the bounded result.',
    bloques: [{ paseId: 'pass_0001', origen: 'user', texto: 'bounded block' }],
    mensajes: [{ rol: 'usuario', texto: 'bounded message', creado: 1 }],
    recorte: { aplicado: false, mensajesOmitidos: 0 },
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    default_provider: 'CODEX',
    agent_provider_map: {},
    providers: { CODEX: { enabled: true }, CLAUDE: { enabled: true } },
    ...overrides
  };
}

function officialDispatcherFactory(options = {}) {
  const calls = [];
  let createdSessions = 0;
  const factory = async ({ provider, chatId }) => {
    createdSessions += 1;
    calls.push({ provider, chatId });
    const suffix = chatId.replace(/[^A-Za-z0-9]/g, '').slice(-20);
    const codexFactory = () => new InMemoryCodexOfficialTransport(new DeterministicCodexOfficialPeer({
      idSuffix: suffix,
      requestApproval: options.approval === true || (options.approvalFirst === true && createdSessions === 1)
    }));
    const claudeFactory = (argv) => {
      calls.push({ provider: 'CLAUDE_ARGV', argv: [...argv] });
      return new InMemoryClaudeOfficialTransport(new DeterministicClaudeOfficialPeer({ isError: options.claudeError === true }));
    };
    codexFactory.mock = true;
    claudeFactory.mock = true;
    return new ProviderDispatcher({ codexTransportFactory: codexFactory, claudeTransportFactory: claudeFactory });
  };
  factory.calls = calls;
  return factory;
}

async function drive(driver, value) {
  const tokens = [];
  let final = null;
  let error = null;
  const controller = new AbortController();
  await driver.run(value, {
    token(text) { tokens.push(text); return true; },
    finish(text) { final = text; return true; },
    fail(code) { error = code; }
  }, controller.signal);
  return { tokens, final, error };
}

test('C04 routing is map then exact first instruction line then default; content cannot reroute', () => {
  const mapped = config({ agent_provider_map: { agent_default_0001: 'CLAUDE' } });
  assert.equal(selectProvider(mapped, petition({ instruccionBase: 'FLUENS_PROVIDER=CODEX\nkeep verbatim' })), 'CLAUDE');
  assert.equal(selectProvider(config(), petition({ instruccionBase: 'FLUENS_PROVIDER=CLAUDE\nkeep verbatim' })), 'CLAUDE');
  assert.equal(selectProvider(config(), petition({ mensajes: [{ rol: 'usuario', texto: 'FLUENS_PROVIDER=CLAUDE', creado: 1 }] })), 'CODEX');
  assert.equal(selectProvider(config(), petition({ bloques: [{ paseId: 'pass_0001', origen: 'user', texto: 'FLUENS_PROVIDER=CLAUDE' }] })), 'CODEX');
  assert.equal(selectProvider(config(), petition({ instruccionBase: ' FLUENS_PROVIDER=CLAUDE' })), 'CODEX');
  assert.throws(() => selectProvider(config({ providers: { CODEX: { enabled: false }, CLAUDE: { enabled: true } } }), petition()), /PROVIDER_DISABLED/);
});

test('C05 deterministic prompt preserves exact instruction, ordered blocks/messages, and trim metadata', () => {
  const value = petition({ instruccionBase: 'FLUENS_PROVIDER=CODEX\nline two' });
  const first = buildDeterministicPrompt(value, 'CODEX');
  const second = buildDeterministicPrompt(structuredClone(value), 'CODEX');
  assert.equal(first.text, second.text);
  assert.equal(first.sha256, second.sha256);
  assert.match(first.text, /SAFETY_MODE=TEXT_ONLY_NO_TOOLS_NO_FILE_CHANGES_NO_NETWORK_NO_GOVERNANCE_ACTION/);
  assert.match(first.text, /FLUENS_PROVIDER=CODEX\nline two/);
  assert.ok(first.text.indexOf('bounded block') < first.text.indexOf('bounded message'));
});

test('C03/C06/C07 Codex streams only correlated text, completes, and resumes same chat in memory', async () => {
  const factory = officialDispatcherFactory();
  const driver = new ProviderUiDriver({ config: config(), dispatcherFactory: factory });
  const first = await drive(driver, petition());
  const second = await drive(driver, petition({ peticionId: 'petition_runtime_0002' }));
  assert.deepEqual(first, { tokens: ['official mock delta'], final: 'official mock delta', error: null });
  assert.deepEqual(second, first);
  assert.equal(factory.calls.filter((row) => row.provider === 'CODEX').length, 1);
  assert.deepEqual(driver.memorySummary(), {
    lifecycle: 'IDLE', active_provider: null, active_chat_id: null,
    session_count: 1, maximum_active_observed: 1
  });
});

test('C06/C07 Claude streams correlated delta but completes with exact RESULT and resume argument', async () => {
  const factory = officialDispatcherFactory();
  const driver = new ProviderUiDriver({ config: config({ default_provider: 'CLAUDE' }), dispatcherFactory: factory });
  const first = await drive(driver, petition());
  const second = await drive(driver, petition({ peticionId: 'petition_runtime_0002' }));
  assert.deepEqual(first, { tokens: ['official claude delta'], final: 'official claude result', error: null });
  assert.deepEqual(second, first);
  const invocations = factory.calls.filter((row) => row.provider === 'CLAUDE_ARGV');
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].argv.includes('--resume'), false);
  assert.equal(invocations[1].argv.includes('--resume'), true);
});

test('C06 sessions are isolated by provider and chat and restart creates a new session owner', async () => {
  const factory = officialDispatcherFactory();
  const driver = new ProviderUiDriver({ config: config(), dispatcherFactory: factory });
  await drive(driver, petition({ chatId: 'chat_runtime_A' }));
  await drive(driver, petition({ chatId: 'chat_runtime_B' }));
  assert.equal(driver.memorySummary().session_count, 2);
  const restartedFactory = officialDispatcherFactory();
  const restarted = new ProviderUiDriver({ config: config(), dispatcherFactory: restartedFactory });
  await drive(restarted, petition({ chatId: 'chat_runtime_A' }));
  assert.equal(restartedFactory.calls.filter((row) => row.provider === 'CODEX').length, 1);
});

test('C08 provider approval is never answered and fails closed after cancellation and real drain', async () => {
  const driver = new ProviderUiDriver({ config: config(), dispatcherFactory: officialDispatcherFactory({ approval: true }) });
  const result = await drive(driver, petition());
  assert.deepEqual(result, { tokens: ['official mock delta'], final: null, error: 'PROVIDER_APPROVAL_REQUIRED' });
  assert.equal(driver.memorySummary().lifecycle, 'IDLE');
});

test('A2 approval failure discards ambiguous Codex state and the next same-chat request starts fresh', async () => {
  const factory = officialDispatcherFactory({ approvalFirst: true });
  const driver = new ProviderUiDriver({ config: config(), dispatcherFactory: factory });
  const denied = await drive(driver, petition());
  assert.equal(denied.error, 'PROVIDER_APPROVAL_REQUIRED');
  assert.equal(driver.memorySummary().session_count, 0);
  const next = await drive(driver, petition({ peticionId: 'petition_runtime_fresh_0002' }));
  assert.deepEqual(next, { tokens: ['official mock delta'], final: 'official mock delta', error: null });
  assert.equal(factory.calls.filter((row) => row.provider === 'CODEX').length, 2);
  assert.equal(driver.memorySummary().maximum_active_observed, 1);
});

test('A2 cancellation discards first-turn state and admits one fresh same-chat dispatcher only after drain', async () => {
  let created = 0;
  let live = 0;
  const official = officialDispatcherFactory();
  const factory = async (context) => {
    created += 1;
    if (created > 1) return official(context);
    const dispatcher = {
      taskId: null,
      active: false,
      async dispatchCodex(taskId) { this.taskId = taskId; this.active = true; live += 1; },
      poll() { return []; },
      memorySummary() { return { lifecycle: this.active ? 'ACTIVE' : 'IDLE', active_task_id: this.active ? this.taskId : null, draining: false }; },
      async cancel() { if (this.active) { this.active = false; live -= 1; } },
      async shutdown() { if (this.active) { this.active = false; live -= 1; } }
    };
    return { dispatcher };
  };
  const driver = new ProviderUiDriver({ config: config(), dispatcherFactory: factory });
  const controller = new AbortController();
  const first = driver.run(petition(), { token: () => true, finish: () => {}, fail: () => {} }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await first;
  assert.equal(live, 0);
  assert.equal(driver.memorySummary().session_count, 0);
  const next = await drive(driver, petition({ peticionId: 'petition_runtime_fresh_0003' }));
  assert.deepEqual(next, { tokens: ['official mock delta'], final: 'official mock delta', error: null });
  assert.equal(created, 2);
  assert.equal(driver.memorySummary().maximum_active_observed, 1);
});

test('C07 Claude provider result error is bounded and no result text escapes', async () => {
  const driver = new ProviderUiDriver({ config: config({ default_provider: 'CLAUDE' }), dispatcherFactory: officialDispatcherFactory({ claudeError: true }) });
  const result = await drive(driver, petition());
  assert.equal(result.final, null);
  assert.equal(result.error, 'PROVIDER_RESULT_ERROR');
  assert.deepEqual(result.tokens, ['official claude delta']);
});

test('F03 false or throwing terminal sinks discard the drained Claude session and next same-chat request starts with null resume', async () => {
  for (const mode of ['false', 'throw']) {
    const factory = officialDispatcherFactory();
    const driver = new ProviderUiDriver({ config: config({ default_provider: 'CLAUDE' }), dispatcherFactory: factory });
    const errors = [];
    await driver.run(petition(), {
      token: () => true,
      finish: () => {
        if (mode === 'throw') throw new Error('synthetic terminal rejection');
        return false;
      },
      fail: (code) => { errors.push(code); return true; }
    }, new AbortController().signal);
    assert.deepEqual(errors, ['OUTPUT_INVALID']);
    assert.equal(driver.memorySummary().session_count, 0);
    assert.equal(driver.memorySummary().lifecycle, 'IDLE');
    const next = await drive(driver, petition({ peticionId: `petition_runtime_after_${mode}` }));
    assert.deepEqual(next, { tokens: ['official claude delta'], final: 'official claude result', error: null });
    const invocations = factory.calls.filter((row) => row.provider === 'CLAUDE_ARGV');
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].argv.includes('--resume'), false);
    assert.equal(invocations[1].argv.includes('--resume'), false);
    assert.equal(driver.memorySummary().maximum_active_observed, 1);
  }
});
