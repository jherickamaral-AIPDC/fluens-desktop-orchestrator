import { CodexAppServerAdapter, ClaudeStreamJsonAdapter } from './adapters.mjs';
import { EngineError, errorCode, isSafeToken } from './util.mjs';
import { IncrementalProviderTransport, codexAppServerPlan, claudeStreamJsonPlan } from './provider-runner.mjs';

function textInput(value) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1048576 || value.includes('\0')) throw new EngineError('DISPATCH_TEXT_INVALID');
  return value;
}

export class ProviderDispatcher {
  constructor(options) {
    if (options === null || typeof options !== 'object' || typeof options.codexTransportFactory !== 'function' || typeof options.claudeTransportFactory !== 'function') throw new EngineError('DISPATCHER_OPTIONS_INVALID');
    this.codexTransportFactory = options.codexTransportFactory;
    this.claudeTransportFactory = options.claudeTransportFactory;
    this.providerEffectsAuthorized = options.providerEffectsAuthorized === true;
    this.codex = null;
    this.codexTasks = new Map();
    this.claude = null;
    this.active = null;
    this.lifecycle = 'IDLE';
    this.drainPromise = null;
    this.events = new Map();
  }

  #queue(taskId, event) {
    const queue = this.events.get(taskId) ?? [];
    queue.push(Object.freeze({ schema: 'FLUENS_ORCHENGINE_PROVIDER_EVENT_V1', task_id: taskId, ...event }));
    this.events.set(taskId, queue);
  }

  poll(taskId, maximum = 100) {
    if (!isSafeToken(taskId, 8, 96) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1000) throw new EngineError('DISPATCH_POLL_INVALID');
    const queue = this.events.get(taskId) ?? [];
    const output = queue.splice(0, maximum);
    return Object.freeze(output);
  }

  async dispatchCodex(taskId, text, resumeHandle = null) {
    textInput(text);
    this.#reserveDispatch(taskId, 'CODEX');
    let entry = null;
    let cleanupStarted = false;
    try {
      entry = this.codexTasks.get(taskId) ?? null;
      if (entry === null) {
        if (resumeHandle !== null) throw new EngineError('CODEX_RESUME_HANDLE_TASK_INVALID');
        entry = this.#newCodexEntry(taskId);
        this.codexTasks.set(taskId, entry);
      } else if (this.codex !== entry || entry.transport === null) {
        if (!entry.adapter.ownsThreadHandle(resumeHandle)) throw new EngineError('CODEX_RESUME_HANDLE_TASK_INVALID');
      } else if (resumeHandle !== null) throw new EngineError('CODEX_RESUME_ONLY_ON_NEW_TRANSPORT');
      cleanupStarted = true;
      if (this.claude?.transport !== null && this.claude?.transport !== undefined) await this.#closeClaudeEntry(this.claude);
      if (this.codex !== entry && this.codex?.transport !== null) await this.#closeCodexEntry(this.codex);
      await this.#awaitCodexCleanups();
      this.#activateReserved(taskId, 'CODEX');
      if (entry.transport === null) {
        const transport = this.codexTransportFactory(taskId);
        entry.transport = transport;
        entry.pendingText = text;
        entry.resumeHandle = resumeHandle;
        this.codex = entry;
        await transport.start({
          onMessage: (message) => this.#codexMessage(entry, message),
          onExit: (summary) => this.#codexTransportExit(entry, summary),
          onError: (error) => this.#codexTransportError(entry, error),
          isComplete: () => this.active?.provider !== 'CODEX' || this.active.taskId !== entry.taskId
        });
        entry.adapter.beginInitialize();
      } else {
        entry.pendingText = text;
        entry.adapter.startTurn(text);
      }
      return Object.freeze({ provider: 'CODEX', dispatch_started: true });
    } catch (error) {
      await this.#recoverDispatchFailure(taskId, 'CODEX', async () => {
        if (!cleanupStarted) return;
        if (entry?.transport !== null && entry?.transport !== undefined) await this.#closeCodexEntry(entry);
        if (this.codex?.transport !== null && this.codex?.transport !== undefined && this.codex !== entry) await this.#closeCodexEntry(this.codex);
        if (this.claude?.transport !== null && this.claude?.transport !== undefined) await this.#closeClaudeEntry(this.claude);
      });
      throw error;
    }
  }

  #newCodexEntry(taskId) {
    const entry = { taskId, transport: null, adapter: null, pendingText: null, resumeHandle: null, cleanupPromise: Promise.resolve() };
    entry.adapter = new CodexAppServerAdapter((message) => {
      if (entry.transport === null) throw new EngineError('CODEX_TRANSPORT_UNAVAILABLE');
      entry.transport.writeObject(message).catch((error) => this.#codexTransportError(entry, error));
    });
    return entry;
  }

  async #codexMessage(entry, message) {
    if (this.codex !== entry || this.active?.provider !== 'CODEX' || this.active.taskId !== entry.taskId) throw new EngineError('CODEX_EVENT_WITHOUT_ACTIVE_TURN');
    const normalized = entry.adapter.receive(message);
    const taskId = entry.taskId;
    this.#queue(taskId, normalized);
    if (normalized.event === 'INITIALIZED') {
      entry.adapter.sendInitialized();
      if (entry.resumeHandle === null) entry.adapter.startThread();
      else entry.adapter.resumeThread(entry.resumeHandle);
    } else if (normalized.event === 'THREAD_READY') {
      entry.adapter.startTurn(entry.pendingText);
      entry.pendingText = null;
      entry.resumeHandle = null;
    } else if (normalized.event === 'TURN_COMPLETED' || (normalized.event === 'REQUEST_ERROR' && ['initialize', 'thread/start', 'thread/resume', 'turn/start'].includes(normalized.method))) {
      this.active.complete = true;
      this.active = null;
      if (this.lifecycle === 'ACTIVE') this.lifecycle = 'IDLE';
    }
  }

  async #closeCodexEntry(entry) {
    const transport = entry?.transport;
    if (transport === null || transport === undefined) return;
    transport.shutdown();
    try { await transport.completion(); }
    catch { /* a closed transport may retain its fail-closed error event */ }
    if (typeof transport.isDrained === 'function' && !transport.isDrained()) throw new EngineError('PROVIDER_DRAIN_INCOMPLETE');
    if (entry.transport === transport) {
      entry.adapter.transportDisconnected();
      entry.transport = null;
    }
    entry.cleanupPromise = Promise.resolve();
    if (this.codex === entry) this.codex = null;
  }

  async #awaitCodexCleanups() {
    await Promise.all([...this.codexTasks.values()].map((entry) => entry.cleanupPromise));
  }

  async dispatchClaude(taskId, text, resumeHandle = null) {
    textInput(text);
    this.#reserveDispatch(taskId, 'CLAUDE');
    const adapter = this.claude?.taskId === taskId ? this.claude.adapter : new ClaudeStreamJsonAdapter();
    try {
      if (this.codex?.transport !== null && this.codex?.transport !== undefined) await this.#closeCodexEntry(this.codex);
      await this.#awaitCodexCleanups();
      if (this.claude?.transport !== null && this.claude?.transport !== undefined) await this.#closeClaudeEntry(this.claude);
      const input = adapter.beginReview(text, resumeHandle);
      const transport = this.claudeTransportFactory(adapter.invocationArguments());
      this.claude = { transport, adapter, resultSeen: false, taskId };
      this.#activateReserved(taskId, 'CLAUDE');
      await transport.start({
        onMessage: (message) => this.#claudeMessage(message),
        onExit: (summary) => this.#claudeExit(summary),
        onError: (error) => this.#transportError(taskId, 'CLAUDE', error),
        isComplete: () => this.claude?.resultSeen === true
      });
      await transport.writeObject(input);
      await transport.endInput();
      return Object.freeze({ provider: 'CLAUDE', dispatch_started: true });
    } catch (error) {
      adapter.abort();
      await this.#recoverDispatchFailure(taskId, 'CLAUDE', async () => {
        if (this.claude?.taskId === taskId && this.claude.transport !== null) await this.#closeClaudeEntry(this.claude);
        if (this.codex?.transport !== null && this.codex?.transport !== undefined) await this.#closeCodexEntry(this.codex);
      });
      throw error;
    }
  }

  async #claudeMessage(message) {
    if (this.claude === null || this.active?.provider !== 'CLAUDE') throw new EngineError('CLAUDE_EVENT_WITHOUT_ACTIVE_TURN');
    const normalized = this.claude.adapter.receive(message);
    if (normalized.event === 'RESULT') this.claude.resultSeen = true;
    this.#queue(this.claude.taskId, normalized);
  }

  async #claudeExit(summary) {
    if (this.claude === null) return;
    const taskId = this.claude.taskId;
    if (summary.cancelled) {
      this.claude.adapter.abort();
      this.#queue(taskId, { provider: 'CLAUDE', event: 'TRANSPORT_EXIT', exit_code: summary.exit_code, stderr_bytes: summary.stderr.bytes, stderr_sha256: summary.stderr.sha256 });
    } else {
      try { this.#queue(taskId, this.claude.adapter.finish(summary.exit_code)); }
      catch (error) { void this.#transportError(taskId, 'CLAUDE', error); return; }
    }
    if (this.active?.taskId === taskId && this.active.provider === 'CLAUDE') {
      this.active = null;
      if (this.lifecycle === 'ACTIVE') this.lifecycle = 'IDLE';
    }
    this.claude.transport = null;
  }

  async #closeClaudeEntry(entry) {
    const transport = entry?.transport;
    if (transport === null || transport === undefined) return;
    transport.shutdown();
    try { await transport.completion(); }
    catch { /* a closed transport may retain its fail-closed error event */ }
    if (typeof transport.isDrained === 'function' && !transport.isDrained()) throw new EngineError('PROVIDER_DRAIN_INCOMPLETE');
    if (entry.transport === transport) entry.transport = null;
    entry.adapter.abort();
  }

  resolveApproval(taskId, handle, decision) {
    if (this.active?.taskId !== taskId || this.active.provider !== 'CODEX' || this.codex === null) throw new EngineError('APPROVAL_NOT_ACTIVE');
    this.codex.adapter.resolveApproval(handle, decision);
    return Object.freeze({ approval_sent: true });
  }

  controlCodex(taskId, action, text = null) {
    if (this.active?.taskId !== taskId || this.active.provider !== 'CODEX' || this.codex === null) throw new EngineError('CODEX_CONTROL_NOT_ACTIVE');
    if (action === 'STEER') this.codex.adapter.steerTurn(textInput(text));
    else if (action === 'INTERRUPT') this.codex.adapter.interruptTurn();
    else throw new EngineError('CODEX_CONTROL_INVALID');
    return Object.freeze({ control_sent: true });
  }

  async cancel(taskId) {
    if (this.active?.taskId !== taskId) throw new EngineError('DISPATCH_CANCEL_NOT_ACTIVE');
    const provider = this.active.provider;
    this.#queue(taskId, { provider, event: 'CANCEL_REQUESTED' });
    let changed = false;
    await this.#drain(taskId, provider, async () => {
      if (provider === 'CODEX') {
        changed = this.codex.transport.cancel();
        await this.#closeCodexEntry(this.codex);
      } else {
        changed = this.claude.transport.cancel();
        await this.#closeClaudeEntry(this.claude);
      }
    });
    return changed;
  }

  async shutdown() {
    if (this.drainPromise !== null) await this.drainPromise.catch(() => {});
    const taskId = this.active?.taskId ?? this.codex?.taskId ?? this.claude?.taskId ?? 'task_shutdown_internal';
    const provider = this.active?.provider ?? (this.codex?.transport ? 'CODEX' : 'CLAUDE');
    await this.#drain(taskId, provider, async () => {
      if (this.codex?.transport !== null && this.codex?.transport !== undefined) await this.#closeCodexEntry(this.codex);
      await this.#awaitCodexCleanups();
      if (this.claude?.transport !== null && this.claude?.transport !== undefined) await this.#closeClaudeEntry(this.claude);
    });
  }

  #codexTransportExit(entry, summary) {
    this.#queue(entry.taskId, { provider: 'CODEX', event: 'TRANSPORT_EXIT', exit_code: summary.exit_code, stderr_bytes: summary.stderr.bytes, stderr_sha256: summary.stderr.sha256 });
    if (this.active?.taskId === entry.taskId && this.active.provider === 'CODEX') {
      this.active = null;
      if (this.lifecycle === 'ACTIVE') this.lifecycle = 'IDLE';
    }
    entry.adapter.transportDisconnected();
    entry.transport = null;
    entry.cleanupPromise = Promise.resolve();
    if (this.codex === entry) this.codex = null;
  }

  #codexTransportError(entry, error) {
    this.#queue(entry.taskId, { provider: 'CODEX', event: 'TRANSPORT_ERROR', error_code: errorCode(error) });
    const transport = entry.transport;
    if (transport === null) return Promise.resolve();
    entry.cleanupPromise = this.#drain(entry.taskId, 'CODEX', () => this.#closeCodexEntry(entry));
    return entry.cleanupPromise;
  }

  #transportError(taskId, provider, error) {
    this.#queue(taskId, { provider, event: 'TRANSPORT_ERROR', error_code: errorCode(error) });
    if (provider !== 'CLAUDE' || this.claude === null) return Promise.resolve();
    return this.#drain(taskId, provider, () => this.#closeClaudeEntry(this.claude));
  }

  #reserveDispatch(taskId, provider) {
    if (!isSafeToken(taskId, 8, 96) || this.active !== null || this.lifecycle !== 'IDLE' || this.drainPromise !== null) throw new EngineError('PROVIDER_TURN_ALREADY_ACTIVE');
    if (!this.providerEffectsAuthorized && !(this.codexTransportFactory.mock === true && this.claudeTransportFactory.mock === true)) throw new EngineError('PROVIDER_EFFECTS_NOT_AUTHORIZED');
    if (!['CODEX', 'CLAUDE'].includes(provider)) throw new EngineError('PROVIDER_INVALID');
    this.lifecycle = 'DRAINING';
  }

  #activateReserved(taskId, provider) {
    if (this.lifecycle !== 'DRAINING' || this.active !== null || this.drainPromise !== null) throw new EngineError('PROVIDER_LIFECYCLE_INVALID');
    this.active = { taskId, provider, complete: false };
    this.lifecycle = 'ACTIVE';
  }

  async #recoverDispatchFailure(taskId, provider, cleanup) {
    if (this.drainPromise !== null) {
      await this.drainPromise;
      return;
    }
    await this.#drain(taskId, provider, cleanup);
  }

  #drain(taskId, provider, cleanup) {
    if (this.drainPromise !== null) return this.drainPromise;
    if (!['IDLE', 'ACTIVE', 'DRAINING'].includes(this.lifecycle)) return Promise.reject(new EngineError('PROVIDER_LIFECYCLE_INVALID'));
    if (this.active !== null && (this.active.taskId !== taskId || this.active.provider !== provider)) return Promise.reject(new EngineError('PROVIDER_DRAIN_CORRELATION_INVALID'));
    this.lifecycle = 'DRAINING';
    this.active = null;
    let operation;
    operation = (async () => {
      let clean = false;
      try {
        await cleanup();
        clean = true;
      }
      finally {
        if (this.drainPromise === operation) {
          this.drainPromise = null;
          if (clean) this.lifecycle = 'IDLE';
        }
      }
    })();
    this.drainPromise = operation;
    return operation;
  }

  memorySummary() {
    return Object.freeze({ lifecycle: this.lifecycle, active_provider: this.active?.provider ?? null, active_task_id: this.active?.taskId ?? null, draining: this.drainPromise !== null });
  }
}

export function createRealProviderDispatcher(config) {
  const bounds = config.runtime.bounds;
  const common = (mode, timeoutMs) => ({
    mode, cwd: config.runtime.cwd, env: config.runtime.environment, timeoutMs,
    maximumLineBytes: bounds.maximum_line_bytes,
    maximumStdoutBytes: bounds.maximum_stdout_bytes,
    maximumStderrBytes: bounds.maximum_stderr_bytes,
    maximumLines: bounds.maximum_lines
  });
  const codexTransportFactory = () => {
    if (!config.providers.codex.enabled) throw new EngineError('CODEX_PROVIDER_DISABLED');
    return new IncrementalProviderTransport(codexAppServerPlan(config.providers.codex.pin), common('PERSISTENT', bounds.codex_timeout_ms));
  };
  const claudeTransportFactory = (argv) => {
    if (!config.providers.claude.enabled) throw new EngineError('CLAUDE_PROVIDER_DISABLED');
    return new IncrementalProviderTransport(claudeStreamJsonPlan(config.providers.claude.pin, argv), common('ONESHOT', bounds.claude_timeout_ms));
  };
  return new ProviderDispatcher({ codexTransportFactory, claudeTransportFactory, providerEffectsAuthorized: config.controls.provider_effects_authorized });
}
