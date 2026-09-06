import { assertPetition } from '../vendor/bridge/contracts.mjs';
import { BridgeError } from '../vendor/bridge/util.mjs';
import { sha256Text } from '../vendor/engine/util.mjs';
import { buildDeterministicPrompt, selectProvider } from './prompt.mjs';

const PASSIVE_EVENTS = new Set([
  'INITIALIZED', 'THREAD_READY', 'THREAD_STARTED', 'TURN_ACCEPTED', 'TURN_STARTED',
  'ITEM_STARTED', 'ITEM_COMPLETED', 'VISIBLE_CONTENT', 'PLAN_UPDATED', 'WARNING',
  'SAFE_NOTIFICATION', 'SESSION_READY', 'STREAM_EVENT', 'ASSISTANT_MESSAGE',
  'APPROVAL_RESOLVED', 'STEER_ACCEPTED', 'INTERRUPT_ACCEPTED'
]);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safePublicCode(value, fallback = 'PROVIDER_FAILURE') {
  return typeof value === 'string' && /^[A-Z0-9_]{3,80}$/.test(value) ? value : fallback;
}

function providerEventFailureCode(event) {
  const inner = safePublicCode(event?.error_code ?? event?.code, null);
  return inner ?? `PROVIDER_${event.event}`;
}

export class ProviderUiDriver {
  constructor({ config, dispatcherFactory, pollIntervalMs = 1 }) {
    if (!config || typeof config !== 'object' || typeof dispatcherFactory !== 'function' ||
        !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 100) {
      throw new BridgeError('PROVIDER_DRIVER_OPTIONS_INVALID');
    }
    this.kind = 'DETERMINISTIC_MOCK_DRIVER'; // Exact sealed UIBRIDGE001 seam discriminator.
    this.runtimeKind = 'ENGINE_MANAGED_PROVIDER_DRIVER';
    this.config = config;
    this.dispatcherFactory = dispatcherFactory;
    this.pollIntervalMs = pollIntervalMs;
    this.sessions = new Map();
    this.active = null;
    this.draining = null;
    this.poisoned = false;
    this.maximumActiveObserved = 0;
  }

  async run(petition, sink, signal) {
    assertPetition(petition);
    if (!sink || typeof sink.token !== 'function' || typeof sink.finish !== 'function' || typeof sink.fail !== 'function' ||
        !signal || typeof signal.addEventListener !== 'function') throw new BridgeError('PROVIDER_DRIVER_SEAM_INVALID');
    if (this.poisoned) throw new BridgeError('PROVIDER_DRAIN_INCOMPLETE');
    if (this.active !== null || this.draining !== null) throw new BridgeError('PROVIDER_TURN_ALREADY_ACTIVE');
    const provider = selectProvider(this.config, petition);
    const prompt = buildDeterministicPrompt(petition, provider);
    const session = await this.#session(provider, petition.chatId);
    const turn = { provider, chatId: petition.chatId, taskId: session.taskId, dispatcher: session.dispatcher, cancelled: false };
    this.active = turn;
    this.maximumActiveObserved = Math.max(this.maximumActiveObserved, 1);
    let terminal = null;
    try {
      const resumeHandle = session.turns === 0 ? null : session.handle;
      if (provider === 'CODEX') await session.dispatcher.dispatchCodex(session.taskId, prompt.text, resumeHandle);
      else await session.dispatcher.dispatchClaude(session.taskId, prompt.text, resumeHandle);
      terminal = await this.#pump(session, sink, signal);
    } catch (error) {
      terminal = { kind: 'error', code: safePublicCode(error?.code) };
    } finally {
      let drained = false;
      try {
        await this.#drain(session);
        drained = true;
      } catch {
        this.poisoned = true;
        terminal = { kind: 'error', code: 'PROVIDER_DRAIN_INCOMPLETE' };
      }
      if (drained && (terminal?.kind !== 'finished' || signal.aborted)) {
        this.sessions.delete(`${session.provider}:${session.chatId}`);
      }
      if (this.active === turn) this.active = null;
    }
    if (signal.aborted) return;
    if (terminal?.kind === 'finished') {
      let accepted = false;
      try {
        accepted = sink.finish(terminal.text) === true;
      } catch {
        accepted = false;
      }
      if (!accepted) {
        // A downstream terminal rejection makes the provider resume handle
        // ambiguous even though provider-side drain already completed.
        this.sessions.delete(`${session.provider}:${session.chatId}`);
        try { sink.fail('OUTPUT_INVALID'); } catch { /* terminal notification is best effort and exactly once */ }
      }
    } else {
      try { sink.fail(safePublicCode(terminal?.code)); } catch { /* public sink cannot retain provider state */ }
    }
  }

  async #session(provider, chatId) {
    const key = `${provider}:${chatId}`;
    let session = this.sessions.get(key);
    if (session) return session;
    const created = await this.dispatcherFactory({ provider, chatId });
    const dispatcher = created?.dispatcher ?? created;
    if (!dispatcher || typeof dispatcher.poll !== 'function' || typeof dispatcher.shutdown !== 'function') throw new BridgeError('DISPATCHER_FACTORY_INVALID');
    session = {
      provider,
      chatId,
      taskId: `uir_${sha256Text(key).slice(0, 32)}`,
      dispatcher,
      postLifecycle: typeof created?.postLifecycle === 'function' ? created.postLifecycle : async () => {},
      handle: null,
      turns: 0
    };
    this.sessions.set(key, session);
    return session;
  }

  async #pump(session, sink, signal) {
    let accumulated = '';
    let result = null;
    while (true) {
      if (signal.aborted) {
        await this.#cancelActive(session);
        return { kind: 'cancelled', code: 'REQUEST_CANCELLED' };
      }
      const events = session.dispatcher.poll(session.taskId, 100);
      if (events.length === 0) {
        await wait(this.pollIntervalMs);
        continue;
      }
      for (const event of events) {
        if (event.event === 'THREAD_READY' || event.event === 'SESSION_READY') {
          session.handle = event.handle;
          continue;
        }
        if (event.event === 'TEXT_DELTA') {
          if (!sink.token(event.text)) {
            await this.#cancelActive(session);
            return { kind: 'error', code: 'OUTPUT_LIMIT' };
          }
          accumulated += event.text;
          continue;
        }
        if (event.event === 'APPROVAL_REQUIRED') {
          await this.#cancelActive(session);
          return { kind: 'error', code: 'PROVIDER_APPROVAL_REQUIRED' };
        }
        if (event.event === 'RESULT') {
          result = event;
          continue;
        }
        if (event.event === 'TURN_COMPLETED') {
          if (event.status !== 'completed') return { kind: 'error', code: 'PROVIDER_TURN_FAILED' };
          if (session.handle === null) return { kind: 'error', code: 'PROVIDER_SESSION_MISSING' };
          session.turns += 1;
          return { kind: 'finished', text: accumulated };
        }
        if (event.event === 'STREAM_FINISHED') {
          if (result === null || result.is_error || session.handle === null) return { kind: 'error', code: 'PROVIDER_RESULT_ERROR' };
          session.turns += 1;
          return { kind: 'finished', text: result.text };
        }
        if (['REQUEST_ERROR', 'PROVIDER_ERROR', 'TRANSPORT_ERROR', 'TRANSPORT_EXIT'].includes(event.event)) {
          await this.#cancelActive(session);
          return { kind: 'error', code: providerEventFailureCode(event) };
        }
        if (!PASSIVE_EVENTS.has(event.event)) {
          await this.#cancelActive(session);
          return { kind: 'error', code: 'PROVIDER_EVENT_UNKNOWN' };
        }
      }
    }
  }

  async #cancelActive(session) {
    const summary = session.dispatcher.memorySummary();
    if (summary.active_task_id === session.taskId) await session.dispatcher.cancel(session.taskId).catch(() => {});
  }

  async #drain(session) {
    if (this.draining !== null) return this.draining;
    let operation;
    operation = (async () => {
      try {
        await session.dispatcher.shutdown();
        await session.postLifecycle();
        const residual = session.dispatcher.poll(session.taskId, 1000);
        for (const event of residual) {
          if (event.event !== 'TRANSPORT_EXIT' && event.event !== 'CANCEL_REQUESTED') {
            throw new BridgeError('PROVIDER_DRAIN_EVENT_INVALID');
          }
        }
        const summary = session.dispatcher.memorySummary();
        if (summary.lifecycle !== 'IDLE' || summary.active_task_id !== null || summary.draining) throw new BridgeError('PROVIDER_DRAIN_INCOMPLETE');
      } finally {
        if (this.draining === operation) this.draining = null;
      }
    })();
    this.draining = operation;
    return operation;
  }

  async shutdown() {
    if (this.draining !== null) await this.draining;
    if (this.active !== null) {
      const session = this.sessions.get(`${this.active.provider}:${this.active.chatId}`);
      if (session) {
        await this.#cancelActive(session);
        await this.#drain(session);
      }
      this.active = null;
    }
    for (const session of this.sessions.values()) await this.#drain(session);
  }

  memorySummary() {
    return Object.freeze({
      lifecycle: (this.draining || this.poisoned) ? 'DRAINING' : (this.active ? 'ACTIVE' : 'IDLE'),
      active_provider: this.active?.provider ?? null,
      active_chat_id: this.active?.chatId ?? null,
      session_count: this.sessions.size,
      maximum_active_observed: this.maximumActiveObserved
    });
  }
}
