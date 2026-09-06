export class EffectCounter {
  constructor() { this.provider = 0; this.network = 0; this.process = 0; this.durableFile = 0; }
  snapshot() { return Object.freeze({ provider: this.provider, network: this.network, process: this.process, durable_file: this.durableFile }); }
}

export class DeterministicCodexOfficialPeer {
  constructor(options = {}) {
    const suffix = options.idSuffix ?? '0001';
    this.threadId = `thr_mock_official_${suffix}`;
    this.turnId = `turn_mock_official_${suffix}`;
    this.itemId = `item_mock_official_${suffix}`;
    this.approvalId = options.approvalId ?? 9001;
    this.requestApproval = options.requestApproval === true;
  }

  accept(message) {
    if (message.method === 'initialize') {
      return [{ id: message.id, result: { userAgent: 'codex-app-server/mock', codexHome: '/opaque/codex-home', platformFamily: 'windows', platformOs: 'windows' } }];
    }
    if (message.method === 'initialized') return [];
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      return [
        { id: message.id, result: { thread: { id: this.threadId, sessionId: this.threadId, ephemeral: false }, instructionSources: [] } },
        { method: 'thread/started', params: { thread: { id: this.threadId, sessionId: this.threadId, ephemeral: false } } }
      ];
    }
    if (message.method === 'turn/start') {
      const messages = [
        { id: message.id, result: { turn: { id: this.turnId, status: 'inProgress', items: [], error: null } } },
        { method: 'turn/started', params: { threadId: this.threadId, turn: { id: this.turnId, status: 'inProgress', items: [], error: null } } },
        { method: 'item/started', params: { threadId: this.threadId, turnId: this.turnId, item: { id: this.itemId, type: 'agentMessage', status: 'inProgress' } } },
        { method: 'item/agentMessage/delta', params: { threadId: this.threadId, turnId: this.turnId, itemId: this.itemId, delta: 'official mock delta' } }
      ];
      if (this.requestApproval) {
        messages.push({ method: 'item/commandExecution/requestApproval', id: this.approvalId, params: { threadId: this.threadId, turnId: this.turnId, itemId: this.itemId, command: ['mock', 'read-only'], cwd: '/opaque/mock', reason: 'mock approval', availableDecisions: ['accept', 'decline', 'cancel'] } });
      } else messages.push(...this.#completion());
      return messages;
    }
    if (message.method === 'turn/steer') return [{ id: message.id, result: { turnId: this.turnId } }];
    if (message.method === 'turn/interrupt') return [{ id: message.id, result: {} }];
    if (message.id === this.approvalId && message.result) {
      return [
        { method: 'serverRequest/resolved', params: { threadId: this.threadId, requestId: this.approvalId } },
        ...this.#completion()
      ];
    }
    return [{ id: message.id, error: { code: -32601, message: 'mock method not found' } }];
  }

  #completion() {
    return [
      { method: 'item/completed', params: { threadId: this.threadId, turnId: this.turnId, item: { id: this.itemId, type: 'agentMessage', status: 'completed' } } },
      { method: 'turn/completed', params: { threadId: this.threadId, turn: { id: this.turnId, status: 'completed', items: [], error: null } } }
    ];
  }
}

export class DeterministicClaudeOfficialPeer {
  constructor(options = {}) {
    this.sessionId = 'session-mock-official-0001';
    this.isError = options.isError === true;
  }

  messages() {
    return Object.freeze([
      { type: 'system', subtype: 'init', uuid: 'uuid-init-0001', session_id: this.sessionId, apiKeySource: 'none', claude_code_version: 'mock', cwd: '/opaque/mock', tools: [], mcp_servers: [], mcp_server_errors: [], model: 'mock-model', permissionMode: 'plan', slash_commands: [], output_style: 'default', skills: [], plugins: [], capabilities: ['interrupt_receipt_v1'], analytics_disabled: true, product_feedback_disabled: true, memory_paths: { auto: '/opaque/claude-memory' }, fast_mode_state: 'off', fast_mode_disabled_reason: 'mock_policy' },
      { type: 'stream_event', uuid: 'uuid-delta-0001', session_id: this.sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'official claude delta' } } },
      { type: 'assistant', uuid: 'uuid-assistant-0001', session_id: this.sessionId, parent_tool_use_id: null, message: { id: 'msg_mock', role: 'assistant', content: [{ type: 'text', text: 'official claude delta' }], model: 'mock-model', stop_reason: 'end_turn', usage: {} } },
      { type: 'result', subtype: this.isError ? 'error_during_execution' : 'success', is_error: this.isError, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result: this.isError ? 'mock error result' : 'official claude result', session_id: this.sessionId, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: 'uuid-result-0001' }
    ]);
  }
}

export class InMemoryCodexOfficialTransport {
  constructor(peer, options = {}) {
    this.peer = peer;
    this.options = options;
    this.handlers = null;
    this.closed = false;
    this.completionPromise = new Promise((resolveCompletion) => { this.resolveCompletion = resolveCompletion; });
  }
  async start(handlers) { this.handlers = handlers; this.options.onStart?.(); }
  async writeObject(message) {
    if (this.closed || this.handlers === null) throw new Error('MOCK_TRANSPORT_CLOSED');
    for (const response of this.peer.accept(message)) await this.handlers.onMessage(response);
  }
  endInput() { throw new Error('PERSISTENT_INPUT_MUST_REMAIN_OPEN'); }
  cancel() { return this.shutdown(); }
  shutdown() {
    if (this.closed) return false;
    this.closed = true;
    this.options.onShutdown?.();
    const summary = { exit_code: 0, stdout: { total_bytes: 0, line_count: 0 }, stderr: { bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }, cancelled: true };
    Promise.resolve(this.handlers?.onExit(summary)).then(() => this.resolveCompletion(summary));
    return true;
  }
  completion() { return this.completionPromise; }
  isDrained() { return this.closed; }
  memorySummary() { return Object.freeze({ provider: 'CODEX', closed: this.closed }); }
}

export class InMemoryClaudeOfficialTransport {
  constructor(peer) { this.peer = peer; this.handlers = null; this.input = null; this.closed = false; }
  async start(handlers) { this.handlers = handlers; }
  async writeObject(message) { this.input = message; }
  async endInput() {
    if (this.closed || this.input?.type !== 'user') throw new Error('MOCK_CLAUDE_INPUT_INVALID');
    for (const message of this.peer.messages()) await this.handlers.onMessage(message);
    this.closed = true;
    await this.handlers.onExit({ exit_code: this.peer.isError ? 1 : 0, stdout: { total_bytes: 0, line_count: this.peer.messages().length }, stderr: { bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }, cancelled: false });
  }
  cancel() { this.closed = true; return true; }
  shutdown() { return this.cancel(); }
  completion() { return Promise.resolve({ exit_code: this.peer.isError ? 1 : 0 }); }
  isDrained() { return this.closed; }
  memorySummary() { return Object.freeze({ provider: 'CLAUDE', closed: this.closed }); }
}
