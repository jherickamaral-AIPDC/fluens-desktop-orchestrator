import { EngineError, canonicalJson, isSafeToken, sha256Text } from './util.mjs';

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new EngineError(code);
  return value;
}

function allowedKeys(value, allowed, required, code) {
  object(value, code);
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) throw new EngineError(code);
  if (required.some((key) => !(key in value))) throw new EngineError(code);
  return value;
}

function providerId(value) {
  return typeof value === 'string' && value.length >= 6 && value.length <= 256 && !/[\r\n\0]/.test(value);
}

function rpcId(value) {
  return (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[\r\n\0]/.test(value));
}

function boundedText(value, maximum = 65536) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
}

function boundedOptionalText(value, maximum = 65536) {
  return value === undefined || value === null || boundedText(value, maximum);
}

function boundedTextIncludingEmpty(value, maximum = 65536) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0');
}

function nullableBoundedText(value, maximum = 65536) {
  return value === null || boundedTextIncludingEmpty(value, maximum);
}

function safeInteger32(value) {
  return Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647;
}

function safeInteger64(value) {
  return Number.isSafeInteger(value);
}

function absolutePathText(value) {
  return boundedText(value, 32768) && (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value));
}

function freezeJson(value) {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => freezeJson(entry)));
  if (value !== null && typeof value === 'object') {
    const copy = Object.create(null);
    for (const [key, entry] of Object.entries(value)) copy[key] = freezeJson(entry);
    return Object.freeze(copy);
  }
  return value;
}

function freezeParsedJson(value) {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeParsedJson(entry);
    Object.freeze(value);
  }
  return value;
}

function boundedJsonCopy(value, maximum, code) {
  let encoded;
  try { encoded = canonicalJson(value); }
  catch { throw new EngineError(code); }
  if (Buffer.byteLength(encoded, 'utf8') > maximum) throw new EngineError(code);
  return freezeJson(JSON.parse(encoded));
}

function boundedStringArray(value, maximumItems, maximumItemBytes, code) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems || value.some((entry) => !boundedText(entry, maximumItemBytes))) throw new EngineError(code);
  return Object.freeze([...value]);
}

function threadFromResult(result) {
  allowedKeys(result, ['thread', 'instructionSources'], ['thread'], 'CODEX_THREAD_RESULT_INVALID');
  if ('instructionSources' in result && (!Array.isArray(result.instructionSources) || result.instructionSources.some((entry) => typeof entry !== 'string' || entry.includes('\0') || Buffer.byteLength(entry, 'utf8') > 32768))) throw new EngineError('CODEX_THREAD_RESULT_INVALID');
  const thread = object(result.thread, 'CODEX_THREAD_RESULT_INVALID');
  if (!providerId(thread.id)) throw new EngineError('CODEX_THREAD_RESULT_INVALID');
  let status = 'UNSPECIFIED';
  if ('status' in thread) {
    if (typeof thread.status === 'string' && boundedText(thread.status, 128)) status = thread.status;
    else if (thread.status !== null && typeof thread.status === 'object' && !Array.isArray(thread.status) && isSafeToken(thread.status.type, 1, 64)) status = thread.status.type;
    else throw new EngineError('CODEX_THREAD_RESULT_INVALID');
  }
  return Object.freeze({ id: thread.id, status });
}

function turnFromResult(result) {
  allowedKeys(result, ['turn'], ['turn'], 'CODEX_TURN_RESULT_INVALID');
  const turn = object(result.turn, 'CODEX_TURN_RESULT_INVALID');
  if (!providerId(turn.id) || typeof turn.status !== 'string') throw new EngineError('CODEX_TURN_RESULT_INVALID');
  return turn;
}

const CODEX_APPROVAL_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval'
]);

const CODEX_APPROVAL_DEFAULT_WIRE_DECISIONS = Object.freeze({
  'item/commandExecution/requestApproval': Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']),
  'item/fileChange/requestApproval': Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel'])
});
const CODEX_WIRE_TO_UI_DECISION = Object.freeze({ accept: 'ALLOW_ONCE', acceptForSession: 'ALLOW_SESSION', decline: 'DENY', cancel: 'CANCEL' });
const CODEX_SAFE_NOTIFICATION_METHODS = new Set([
  'item/reasoning/summaryPartAdded',
  'hook/started',
  'hook/completed',
  'model/safetyBuffering/updated',
  'model/rerouted',
  'model/verification',
  'thread/tokenUsage/updated'
]);
const CODEX_CURRENT_BENIGN_NOTIFICATION_METHODS = new Set([
  'thread/name/updated',
  'thread/settings/updated',
  'thread/status/changed',
  'account/rateLimits/updated',
  'item/commandExecution/terminalInteraction'
]);

function validateApprovalPolicy(value) {
  if (['untrusted', 'on-request', 'never'].includes(value)) return;
  allowedKeys(value, ['granular'], ['granular'], 'CODEX_THREAD_SETTINGS_INVALID');
  const granular = allowedKeys(value.granular, ['mcp_elicitations', 'request_permissions', 'rules', 'sandbox_approval', 'skill_approval'], ['mcp_elicitations', 'rules', 'sandbox_approval'], 'CODEX_THREAD_SETTINGS_INVALID');
  for (const key of Object.keys(granular)) if (typeof granular[key] !== 'boolean') throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
}

function validateSandboxPolicy(value) {
  object(value, 'CODEX_THREAD_SETTINGS_INVALID');
  if (value.type === 'dangerFullAccess') {
    allowedKeys(value, ['type'], ['type'], 'CODEX_THREAD_SETTINGS_INVALID');
    return;
  }
  if (value.type === 'readOnly') {
    allowedKeys(value, ['type', 'networkAccess'], ['type'], 'CODEX_THREAD_SETTINGS_INVALID');
    if ('networkAccess' in value && typeof value.networkAccess !== 'boolean') throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
    return;
  }
  if (value.type === 'externalSandbox') {
    allowedKeys(value, ['type', 'networkAccess'], ['type'], 'CODEX_THREAD_SETTINGS_INVALID');
    if ('networkAccess' in value && !['restricted', 'enabled'].includes(value.networkAccess)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
    return;
  }
  if (value.type === 'workspaceWrite') {
    allowedKeys(value, ['type', 'networkAccess', 'excludeSlashTmp', 'excludeTmpdirEnvVar', 'writableRoots'], ['type'], 'CODEX_THREAD_SETTINGS_INVALID');
    for (const key of ['networkAccess', 'excludeSlashTmp', 'excludeTmpdirEnvVar']) if (key in value && typeof value[key] !== 'boolean') throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
    if ('writableRoots' in value && (!Array.isArray(value.writableRoots) || value.writableRoots.length > 256 || value.writableRoots.some((entry) => !absolutePathText(entry)))) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
    return;
  }
  throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
}

function validateCollaborationMode(value) {
  allowedKeys(value, ['mode', 'settings'], ['mode', 'settings'], 'CODEX_THREAD_SETTINGS_INVALID');
  if (!['plan', 'default'].includes(value.mode)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  const settings = allowedKeys(value.settings, ['developer_instructions', 'model', 'reasoning_effort'], ['model'], 'CODEX_THREAD_SETTINGS_INVALID');
  if (!boundedText(settings.model, 256) || ('developer_instructions' in settings && !nullableBoundedText(settings.developer_instructions, 65536)) || ('reasoning_effort' in settings && !nullableBoundedText(settings.reasoning_effort, 128))) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
}

function validateThreadSettings(value) {
  const settings = allowedKeys(value,
    ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'effort', 'model', 'modelProvider', 'personality', 'sandboxPolicy', 'serviceTier', 'summary'],
    ['approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'model', 'modelProvider', 'sandboxPolicy'],
    'CODEX_THREAD_SETTINGS_INVALID');
  if (!absolutePathText(settings.cwd) || !boundedText(settings.model, 256) || !boundedText(settings.modelProvider, 256) || !['user', 'auto_review', 'guardian_subagent'].includes(settings.approvalsReviewer)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  validateApprovalPolicy(settings.approvalPolicy);
  validateCollaborationMode(settings.collaborationMode);
  validateSandboxPolicy(settings.sandboxPolicy);
  if ('activePermissionProfile' in settings && settings.activePermissionProfile !== null) {
    const profile = allowedKeys(settings.activePermissionProfile, ['id', 'extends'], ['id'], 'CODEX_THREAD_SETTINGS_INVALID');
    if (!boundedText(profile.id, 256) || ('extends' in profile && !nullableBoundedText(profile.extends, 256))) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  }
  if ('effort' in settings && !nullableBoundedText(settings.effort, 128)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  if ('serviceTier' in settings && !nullableBoundedText(settings.serviceTier, 128)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  if ('summary' in settings && settings.summary !== null && !['auto', 'concise', 'detailed', 'none'].includes(settings.summary)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
  if ('personality' in settings && settings.personality !== null && !['none', 'friendly', 'pragmatic'].includes(settings.personality)) throw new EngineError('CODEX_THREAD_SETTINGS_INVALID');
}

function validateRateLimitWindow(value) {
  const window = allowedKeys(value, ['usedPercent', 'windowDurationMins', 'resetsAt'], ['usedPercent'], 'CODEX_RATE_LIMITS_INVALID');
  if (!safeInteger32(window.usedPercent) || ('windowDurationMins' in window && window.windowDurationMins !== null && !safeInteger64(window.windowDurationMins)) || ('resetsAt' in window && window.resetsAt !== null && !safeInteger64(window.resetsAt))) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
}

function validateRateLimits(value) {
  const limits = allowedKeys(value, ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'individualLimit', 'spendControlReached', 'planType', 'rateLimitReachedType'], [], 'CODEX_RATE_LIMITS_INVALID');
  for (const key of ['limitId', 'limitName']) if (key in limits && !nullableBoundedText(limits[key], 256)) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
  for (const key of ['primary', 'secondary']) if (key in limits && limits[key] !== null) validateRateLimitWindow(limits[key]);
  if ('credits' in limits && limits.credits !== null) {
    const credits = allowedKeys(limits.credits, ['balance', 'hasCredits', 'unlimited'], ['hasCredits', 'unlimited'], 'CODEX_RATE_LIMITS_INVALID');
    if (typeof credits.hasCredits !== 'boolean' || typeof credits.unlimited !== 'boolean' || ('balance' in credits && !nullableBoundedText(credits.balance, 128))) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
  }
  if ('individualLimit' in limits && limits.individualLimit !== null) {
    const individual = allowedKeys(limits.individualLimit, ['limit', 'used', 'remainingPercent', 'resetsAt'], ['limit', 'used', 'remainingPercent', 'resetsAt'], 'CODEX_RATE_LIMITS_INVALID');
    if (!boundedText(individual.limit, 128) || !boundedText(individual.used, 128) || !safeInteger32(individual.remainingPercent) || !safeInteger64(individual.resetsAt)) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
  }
  if ('spendControlReached' in limits && limits.spendControlReached !== null && typeof limits.spendControlReached !== 'boolean') throw new EngineError('CODEX_RATE_LIMITS_INVALID');
  if ('planType' in limits && limits.planType !== null && !['free', 'go', 'plus', 'pro', 'prolite', 'team', 'self_serve_business_usage_based', 'business', 'enterprise_cbp_usage_based', 'enterprise', 'edu', 'unknown'].includes(limits.planType)) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
  if ('rateLimitReachedType' in limits && limits.rateLimitReachedType !== null && !['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted', 'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'].includes(limits.rateLimitReachedType)) throw new EngineError('CODEX_RATE_LIMITS_INVALID');
}

function validateCurrentBenignNotification(method, params, threadId, turnId) {
  if (method === 'thread/name/updated') {
    allowedKeys(params, ['threadId', 'threadName'], ['threadId'], 'CODEX_THREAD_NAME_INVALID');
    if (params.threadId !== threadId || ('threadName' in params && !nullableBoundedText(params.threadName, 512))) throw new EngineError('CODEX_THREAD_NAME_INVALID');
  } else if (method === 'thread/settings/updated') {
    allowedKeys(params, ['threadId', 'threadSettings'], ['threadId', 'threadSettings'], 'CODEX_THREAD_SETTINGS_INVALID');
    if (params.threadId !== threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
    validateThreadSettings(params.threadSettings);
  } else if (method === 'thread/status/changed') {
    allowedKeys(params, ['threadId', 'status'], ['threadId', 'status'], 'CODEX_THREAD_STATUS_INVALID');
    if (params.threadId !== threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
    const status = object(params.status, 'CODEX_THREAD_STATUS_INVALID');
    if (status.type === 'active') {
      allowedKeys(status, ['type', 'activeFlags'], ['type', 'activeFlags'], 'CODEX_THREAD_STATUS_INVALID');
      if (!Array.isArray(status.activeFlags) || status.activeFlags.length > 2 || new Set(status.activeFlags).size !== status.activeFlags.length || status.activeFlags.some((entry) => !['waitingOnApproval', 'waitingOnUserInput'].includes(entry))) throw new EngineError('CODEX_THREAD_STATUS_INVALID');
    } else {
      allowedKeys(status, ['type'], ['type'], 'CODEX_THREAD_STATUS_INVALID');
      if (!['notLoaded', 'idle', 'systemError'].includes(status.type)) throw new EngineError('CODEX_THREAD_STATUS_INVALID');
    }
  } else if (method === 'account/rateLimits/updated') {
    allowedKeys(params, ['rateLimits'], ['rateLimits'], 'CODEX_RATE_LIMITS_INVALID');
    validateRateLimits(params.rateLimits);
  } else if (method === 'item/commandExecution/terminalInteraction') {
    allowedKeys(params, ['threadId', 'turnId', 'itemId', 'processId', 'stdin'], ['threadId', 'turnId', 'itemId', 'processId', 'stdin'], 'CODEX_TERMINAL_INTERACTION_INVALID');
    if (params.threadId !== threadId || params.turnId !== turnId || !providerId(params.itemId) || !providerId(params.processId) || !boundedTextIncludingEmpty(params.stdin, 65536)) throw new EngineError('CODEX_TERMINAL_INTERACTION_INVALID');
  } else {
    throw new EngineError('CODEX_NOTIFICATION_METHOD_INVALID');
  }
  boundedJsonCopy(params, 524288, 'CODEX_NOTIFICATION_OVERSIZE');
  return Object.freeze({ provider: 'CODEX', event: 'SAFE_NOTIFICATION', method, params_sha256: sha256Text(canonicalJson(params)), transient: true, governance_effects: 0 });
}

function approvalDecisions(method, params) {
  if (method === 'item/permissions/requestApproval') return Object.freeze(['ALLOW_ONCE', 'DENY']);
  const wire = params.availableDecisions ?? CODEX_APPROVAL_DEFAULT_WIRE_DECISIONS[method];
  if (!Array.isArray(wire) || wire.length < 1 || wire.length > 4 || new Set(wire).size !== wire.length || wire.some((entry) => !(entry in CODEX_WIRE_TO_UI_DECISION))) throw new EngineError('CODEX_APPROVAL_AVAILABLE_DECISIONS_INVALID');
  return Object.freeze(wire.map((entry) => CODEX_WIRE_TO_UI_DECISION[entry]));
}

function approvalContext(method, params, activeItem) {
  if (method === 'item/commandExecution/requestApproval') {
    allowedKeys(params, ['threadId', 'turnId', 'itemId', 'environmentId', 'reason', 'command', 'cwd', 'commandActions', 'proposedExecpolicyAmendment', 'networkApprovalContext', 'availableDecisions'], ['threadId', 'turnId', 'itemId'], 'CODEX_COMMAND_APPROVAL_PARAMS_INVALID');
    if (!boundedOptionalText(params.reason, 32768) || !boundedOptionalText(params.cwd, 32768)) throw new EngineError('CODEX_COMMAND_APPROVAL_CONTEXT_INVALID');
    const commandValue = params.command ?? (activeItem?.type === 'commandExecution' ? activeItem.command : undefined);
    const command = commandValue === undefined ? null : boundedStringArray(commandValue, 256, 32768, 'CODEX_COMMAND_APPROVAL_CONTEXT_INVALID');
    const cwd = params.cwd ?? (activeItem?.type === 'commandExecution' && boundedOptionalText(activeItem.cwd, 32768) ? activeItem.cwd ?? null : null);
    const network = params.networkApprovalContext === undefined ? null : boundedJsonCopy(params.networkApprovalContext, 32768, 'CODEX_COMMAND_APPROVAL_CONTEXT_INVALID');
    if (command === null && network === null) throw new EngineError('CODEX_COMMAND_APPROVAL_CONTEXT_INVALID');
    return Object.freeze({
      kind: 'COMMAND_EXECUTION', reason: params.reason ?? null, command, cwd,
      command_actions: params.commandActions === undefined ? null : boundedJsonCopy(params.commandActions, 65536, 'CODEX_COMMAND_APPROVAL_CONTEXT_INVALID'),
      proposed_execpolicy_amendment: params.proposedExecpolicyAmendment === undefined ? null : boundedJsonCopy(params.proposedExecpolicyAmendment, 32768, 'CODEX_COMMAND_APPROVAL_CONTEXT_INVALID'),
      network_approval_context: network
    });
  }
  if (method === 'item/fileChange/requestApproval') {
    allowedKeys(params, ['threadId', 'turnId', 'itemId', 'reason', 'grantRoot', 'availableDecisions'], ['threadId', 'turnId', 'itemId'], 'CODEX_FILE_APPROVAL_PARAMS_INVALID');
    if (!boundedOptionalText(params.reason, 32768) || !boundedOptionalText(params.grantRoot, 32768) || activeItem?.type !== 'fileChange' || !Array.isArray(activeItem.changes)) throw new EngineError('CODEX_FILE_APPROVAL_CONTEXT_INVALID');
    return Object.freeze({
      kind: 'FILE_CHANGE', reason: params.reason ?? null, grant_root: params.grantRoot ?? null,
      changes: boundedJsonCopy(activeItem.changes, 262144, 'CODEX_FILE_APPROVAL_CONTEXT_INVALID')
    });
  }
  allowedKeys(params, ['threadId', 'turnId', 'itemId', 'environmentId', 'cwd', 'reason', 'permissions'], ['threadId', 'turnId', 'itemId', 'environmentId', 'cwd', 'permissions'], 'CODEX_PERMISSION_APPROVAL_PARAMS_INVALID');
  if (!boundedText(params.environmentId, 256) || !boundedText(params.cwd, 32768) || !boundedOptionalText(params.reason, 32768)) throw new EngineError('CODEX_PERMISSION_APPROVAL_CONTEXT_INVALID');
  return Object.freeze({
    kind: 'PERMISSIONS', reason: params.reason ?? null, cwd: params.cwd,
    requested_permissions: boundedJsonCopy(object(params.permissions, 'CODEX_PERMISSION_APPROVAL_CONTEXT_INVALID'), 131072, 'CODEX_PERMISSION_APPROVAL_CONTEXT_INVALID')
  });
}

export class CodexAppServerAdapter {
  #send;
  #nextId = 1;
  #pending = new Map();
  #usedResponseIds = new Set();
  #pendingApprovals = new Map();
  #usedServerRequestIds = new Set();
  #nextApprovalHandleSequence = 1;
  #threadByHandle = new Map();
  #activeItems = new Map();
  #threadId = null;
  #turnId = null;
  #initialized = false;
  #initializedNotificationSent = false;

  constructor(send) {
    if (typeof send !== 'function') throw new EngineError('CODEX_SEND_INVALID');
    this.#send = send;
  }

  #request(method, params) {
    const id = this.#nextId++;
    this.#pending.set(id, method);
    this.#send(Object.freeze({ method, id, params }));
    return id;
  }

  beginInitialize() {
    if (this.#initialized || this.#pending.size !== 0) throw new EngineError('CODEX_INITIALIZE_STATE_INVALID');
    return this.#request('initialize', Object.freeze({
      clientInfo: Object.freeze({ name: 'fluens_orchestrator', title: 'Fluens Orchestrator', version: '1.0.0' }),
      capabilities: Object.freeze({ experimentalApi: false })
    }));
  }

  sendInitialized() {
    if (!this.#initialized || this.#initializedNotificationSent) throw new EngineError('CODEX_INITIALIZED_NOTIFICATION_INVALID');
    this.#initializedNotificationSent = true;
    const message = Object.freeze({ method: 'initialized', params: Object.freeze({}) });
    this.#send(message);
    return message;
  }

  startThread() {
    this.#requireInitialized();
    if (this.#threadId !== null) throw new EngineError('CODEX_THREAD_ALREADY_ACTIVE');
    return this.#request('thread/start', Object.freeze({ ephemeral: false }));
  }

  resumeThread(handle) {
    this.#requireInitialized();
    const threadId = this.#threadByHandle.get(handle);
    if (threadId === undefined || this.#threadId !== null) throw new EngineError('CODEX_THREAD_RESUME_INVALID');
    return this.#request('thread/resume', Object.freeze({ threadId }));
  }

  ownsThreadHandle(handle) {
    return typeof handle === 'string' && this.#threadByHandle.has(handle);
  }

  startTurn(text) {
    this.#requireThread();
    if (this.#turnId !== null || !boundedText(text)) throw new EngineError('CODEX_TURN_START_INVALID');
    return this.#request('turn/start', Object.freeze({
      threadId: this.#threadId,
      input: Object.freeze([Object.freeze({ type: 'text', text })]),
      approvalPolicy: 'on-request'
    }));
  }

  steerTurn(text) {
    this.#requireTurn();
    if (!boundedText(text)) throw new EngineError('CODEX_TURN_STEER_INVALID');
    return this.#request('turn/steer', Object.freeze({
      threadId: this.#threadId,
      input: Object.freeze([Object.freeze({ type: 'text', text })]),
      expectedTurnId: this.#turnId
    }));
  }

  interruptTurn() {
    this.#requireTurn();
    return this.#request('turn/interrupt', Object.freeze({ threadId: this.#threadId, turnId: this.#turnId }));
  }

  receive(message) {
    object(message, 'CODEX_WIRE_MESSAGE_INVALID');
    if ('jsonrpc' in message) throw new EngineError('CODEX_WIRE_JSONRPC_FIELD_FORBIDDEN');
    if ('id' in message && 'method' in message) return this.#approval(message);
    if ('id' in message) return this.#response(message);
    if ('method' in message) return this.#notification(message);
    throw new EngineError('CODEX_WIRE_MESSAGE_INVALID');
  }

  #response(message) {
    allowedKeys(message, ['id', 'result', 'error'], ['id'], 'CODEX_RESPONSE_KEYS_INVALID');
    if (!rpcId(message.id) || this.#usedResponseIds.has(message.id)) throw new EngineError('CODEX_RESPONSE_REPLAY');
    const method = this.#pending.get(message.id);
    if (method === undefined) throw new EngineError('CODEX_RESPONSE_UNCORRELATED');
    if (('result' in message) === ('error' in message)) throw new EngineError('CODEX_RESPONSE_RESULT_ERROR_INVALID');
    this.#pending.delete(message.id);
    this.#usedResponseIds.add(message.id);
    if ('error' in message) {
      const error = object(message.error, 'CODEX_ERROR_RESPONSE_INVALID');
      if (!Number.isInteger(error.code) || typeof error.message !== 'string') throw new EngineError('CODEX_ERROR_RESPONSE_INVALID');
      return Object.freeze({ provider: 'CODEX', event: 'REQUEST_ERROR', method, error_code: error.code, message_sha256: sha256Text(error.message) });
    }
    if (method === 'initialize') {
      allowedKeys(message.result, ['userAgent', 'codexHome', 'platformFamily', 'platformOs'], ['userAgent', 'codexHome', 'platformFamily', 'platformOs'], 'CODEX_INITIALIZE_RESULT_INVALID');
      if (!boundedText(message.result.userAgent, 1024) || !boundedText(message.result.codexHome, 32768) || !isSafeToken(message.result.platformFamily, 1, 40) || !isSafeToken(message.result.platformOs, 1, 40)) throw new EngineError('CODEX_INITIALIZE_RESULT_INVALID');
      this.#initialized = true;
      return Object.freeze({ provider: 'CODEX', event: 'INITIALIZED', user_agent_sha256: sha256Text(message.result.userAgent), codex_home_sha256: sha256Text(message.result.codexHome), platform_family: message.result.platformFamily, platform_os: message.result.platformOs });
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      const thread = threadFromResult(message.result);
      this.#threadId = thread.id;
      const handle = `codex_${sha256Text(thread.id).slice(0, 24)}`;
      this.#threadByHandle.set(handle, thread.id);
      return Object.freeze({ provider: 'CODEX', event: 'THREAD_READY', handle, status: thread.status });
    }
    if (method === 'turn/start') {
      const turn = turnFromResult(message.result);
      this.#turnId = turn.id;
      return Object.freeze({ provider: 'CODEX', event: 'TURN_ACCEPTED', status: turn.status });
    }
    if (method === 'turn/steer') {
      allowedKeys(message.result, ['turnId'], ['turnId'], 'CODEX_STEER_RESULT_INVALID');
      if (message.result.turnId !== this.#turnId) throw new EngineError('CODEX_STEER_RESULT_INVALID');
      return Object.freeze({ provider: 'CODEX', event: 'STEER_ACCEPTED' });
    }
    if (method === 'turn/interrupt') {
      object(message.result, 'CODEX_INTERRUPT_RESULT_INVALID');
      return Object.freeze({ provider: 'CODEX', event: 'INTERRUPT_ACCEPTED' });
    }
    throw new EngineError('CODEX_RESPONSE_METHOD_INVALID');
  }

  #notification(message) {
    allowedKeys(message, ['method', 'params'], ['method', 'params'], 'CODEX_NOTIFICATION_KEYS_INVALID');
    const params = object(message.params, 'CODEX_NOTIFICATION_PARAMS_INVALID');
    switch (message.method) {
      case 'thread/started': {
        const thread = object(params.thread, 'CODEX_THREAD_EVENT_INVALID');
        if (thread.id !== this.#threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        return Object.freeze({ provider: 'CODEX', event: 'THREAD_STARTED' });
      }
      case 'turn/started': {
        const turn = object(params.turn, 'CODEX_TURN_EVENT_INVALID');
        if (turn.id !== this.#turnId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        return Object.freeze({ provider: 'CODEX', event: 'TURN_STARTED', status: turn.status });
      }
      case 'item/agentMessage/delta': {
        if (params.threadId !== this.#threadId || params.turnId !== this.#turnId || !providerId(params.itemId) || !boundedText(params.delta, 262144)) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        return Object.freeze({ provider: 'CODEX', event: 'TEXT_DELTA', text: params.delta, text_sha256: sha256Text(params.delta) });
      }
      case 'item/started':
      case 'item/completed': {
        if (params.threadId !== undefined && params.threadId !== this.#threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        if (params.turnId !== undefined && params.turnId !== this.#turnId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        const item = object(params.item, 'CODEX_ITEM_EVENT_INVALID');
        if (!providerId(item.id) || typeof item.type !== 'string') throw new EngineError('CODEX_ITEM_EVENT_INVALID');
        if (message.method === 'item/started') {
          if (this.#activeItems.has(item.id)) throw new EngineError('CODEX_ITEM_REPLAY');
          this.#activeItems.set(item.id, boundedJsonCopy(item, 524288, 'CODEX_ITEM_EVENT_INVALID'));
        } else {
          if (!this.#activeItems.has(item.id)) throw new EngineError('CODEX_ITEM_UNCORRELATED');
          this.#activeItems.delete(item.id);
        }
        return Object.freeze({ provider: 'CODEX', event: message.method === 'item/started' ? 'ITEM_STARTED' : 'ITEM_COMPLETED', item_type: item.type, item_sha256: sha256Text(canonicalJson(item)) });
      }
      case 'item/reasoning/summaryTextDelta':
        return this.#visibleDelta(message.method, params, 'REASONING_SUMMARY', true, true);
      case 'item/reasoning/textDelta':
        return this.#visibleDelta(message.method, params, 'REASONING_RAW', true, true);
      case 'item/plan/delta':
        return this.#visibleDelta(message.method, params, 'PLAN_DELTA', true, true);
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        return this.#visibleDelta(message.method, params, 'TOOL_OUTPUT', true, true);
      case 'turn/diff/updated':
        return this.#visibleText(message.method, params, 'diff', 'TURN_DIFF', true, true);
      case 'turn/plan/updated':
        return this.#visiblePlan(params);
      case 'warning':
      case 'configWarning':
        return this.#warning(message.method, params);
      case 'turn/completed': {
        if (params.threadId !== undefined && params.threadId !== this.#threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        const turn = object(params.turn, 'CODEX_TURN_EVENT_INVALID');
        if (turn.id !== this.#turnId || !['completed', 'interrupted', 'failed'].includes(turn.status)) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        this.#activeItems.clear();
        this.#pendingApprovals.clear();
        this.#turnId = null;
        return Object.freeze({ provider: 'CODEX', event: 'TURN_COMPLETED', status: turn.status, result_sha256: sha256Text(canonicalJson(turn)) });
      }
      case 'serverRequest/resolved': {
        if (params.threadId !== this.#threadId || !rpcId(params.requestId) || !this.#usedServerRequestIds.has(params.requestId)) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        for (const [handle, pending] of this.#pendingApprovals) if (pending.rpcId === params.requestId) this.#pendingApprovals.delete(handle);
        return Object.freeze({ provider: 'CODEX', event: 'APPROVAL_RESOLVED' });
      }
      case 'error': {
        if (params.threadId !== undefined && params.threadId !== this.#threadId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        if (params.turnId !== undefined && params.turnId !== this.#turnId) throw new EngineError('CODEX_EVENT_UNCORRELATED');
        const error = object(params.error, 'CODEX_ERROR_EVENT_INVALID');
        if (!boundedText(error.message, 65536)) throw new EngineError('CODEX_ERROR_EVENT_INVALID');
        return Object.freeze({ provider: 'CODEX', event: 'PROVIDER_ERROR', message_sha256: sha256Text(error.message), error_sha256: sha256Text(canonicalJson(error)) });
      }
      default:
        if (CODEX_CURRENT_BENIGN_NOTIFICATION_METHODS.has(message.method)) return validateCurrentBenignNotification(message.method, params, this.#threadId, this.#turnId);
        if (CODEX_SAFE_NOTIFICATION_METHODS.has(message.method)) return this.#safeNotification(message.method, params);
        throw new EngineError('CODEX_NOTIFICATION_METHOD_INVALID');
    }
  }

  #correlateNotification(params, requireThread, requireTurn) {
    if ((requireThread && !('threadId' in params)) || ('threadId' in params && params.threadId !== this.#threadId)) throw new EngineError('CODEX_EVENT_UNCORRELATED');
    if ((requireTurn && !('turnId' in params)) || ('turnId' in params && params.turnId !== this.#turnId)) throw new EngineError('CODEX_EVENT_UNCORRELATED');
    boundedJsonCopy(params, 524288, 'CODEX_NOTIFICATION_OVERSIZE');
  }

  #visibleDelta(method, params, contentKind, requireThread, requireTurn) {
    this.#correlateNotification(params, requireThread, requireTurn);
    if (!providerId(params.itemId) || !boundedText(params.delta, 262144)) throw new EngineError('CODEX_VISIBLE_DELTA_INVALID');
    if ('summaryIndex' in params && (!Number.isSafeInteger(params.summaryIndex) || params.summaryIndex < 0)) throw new EngineError('CODEX_VISIBLE_DELTA_INVALID');
    return Object.freeze({ provider: 'CODEX', event: 'VISIBLE_CONTENT', method, content_kind: contentKind, text: params.delta, text_sha256: sha256Text(params.delta) });
  }

  #visibleText(method, params, field, contentKind, requireThread, requireTurn) {
    this.#correlateNotification(params, requireThread, requireTurn);
    if (!boundedText(params[field], 262144)) throw new EngineError('CODEX_VISIBLE_CONTENT_INVALID');
    return Object.freeze({ provider: 'CODEX', event: 'VISIBLE_CONTENT', method, content_kind: contentKind, text: params[field], text_sha256: sha256Text(params[field]) });
  }

  #visiblePlan(params) {
    this.#correlateNotification(params, false, true);
    if (!boundedOptionalText(params.explanation, 65536) || !Array.isArray(params.plan) || params.plan.length > 256) throw new EngineError('CODEX_PLAN_EVENT_INVALID');
    const plan = params.plan.map((entry) => {
      allowedKeys(entry, ['step', 'status'], ['step', 'status'], 'CODEX_PLAN_EVENT_INVALID');
      if (!boundedText(entry.step, 32768) || !['pending', 'inProgress', 'completed'].includes(entry.status)) throw new EngineError('CODEX_PLAN_EVENT_INVALID');
      return Object.freeze({ step: entry.step, status: entry.status });
    });
    return Object.freeze({ provider: 'CODEX', event: 'PLAN_UPDATED', explanation: params.explanation ?? null, plan: Object.freeze(plan), plan_sha256: sha256Text(canonicalJson(plan)) });
  }

  #warning(method, params) {
    this.#correlateNotification(params, false, false);
    const message = method === 'warning' ? params.message : params.summary;
    if (!boundedText(message, 65536)) throw new EngineError('CODEX_WARNING_EVENT_INVALID');
    return Object.freeze({ provider: 'CODEX', event: 'WARNING', method, message, message_sha256: sha256Text(message) });
  }

  #safeNotification(method, params) {
    const reasoningBoundary = method === 'item/reasoning/summaryPartAdded';
    const requireThread = reasoningBoundary || method === 'thread/tokenUsage/updated' || method.startsWith('hook/') || method.startsWith('model/');
    this.#correlateNotification(params, requireThread, reasoningBoundary);
    return Object.freeze({ provider: 'CODEX', event: 'SAFE_NOTIFICATION', method, params_sha256: sha256Text(canonicalJson(params)) });
  }

  #approval(message) {
    allowedKeys(message, ['method', 'id', 'params'], ['method', 'id', 'params'], 'CODEX_APPROVAL_KEYS_INVALID');
    if (!CODEX_APPROVAL_METHODS.includes(message.method) || !rpcId(message.id) || this.#usedServerRequestIds.has(message.id)) throw new EngineError('CODEX_APPROVAL_REQUEST_INVALID');
    const params = object(message.params, 'CODEX_APPROVAL_PARAMS_INVALID');
    if (params.threadId !== this.#threadId || params.turnId !== this.#turnId || !providerId(params.itemId)) throw new EngineError('CODEX_APPROVAL_UNCORRELATED');
    const pinnedParams = boundedJsonCopy(params, 524288, 'CODEX_APPROVAL_PARAMS_INVALID');
    const availableDecisions = approvalDecisions(message.method, pinnedParams);
    const context = approvalContext(message.method, pinnedParams, this.#activeItems.get(params.itemId));
    const approvalSequence = this.#nextApprovalHandleSequence;
    if (!Number.isSafeInteger(approvalSequence) || approvalSequence < 1) throw new EngineError('CODEX_APPROVAL_HANDLE_SEQUENCE_EXHAUSTED');
    this.#nextApprovalHandleSequence += 1;
    const correlationDigest = sha256Text(canonicalJson({
      approval_sequence: approvalSequence,
      item_id: params.itemId,
      method: message.method,
      rpc_id: message.id,
      thread_id: params.threadId,
      turn_id: params.turnId
    })).slice(0, 16);
    const handle = `approval_${String(approvalSequence).padStart(16, '0')}_${correlationDigest}`;
    this.#pendingApprovals.set(handle, Object.freeze({ rpcId: message.id, method: message.method, params: pinnedParams, availableDecisions }));
    this.#usedServerRequestIds.add(message.id);
    return Object.freeze({ provider: 'CODEX', event: 'APPROVAL_REQUIRED', approval_handle: handle, approval_kind: context.kind, available_decisions: availableDecisions, context, details_sha256: sha256Text(canonicalJson(pinnedParams)) });
  }

  resolveApproval(handle, decision) {
    allowedKeys(decision, ['source', 'decision'], ['source', 'decision'], 'UI_APPROVAL_DECISION_INVALID');
    if (decision.source !== 'UI_EXPLICIT' || !['ALLOW_ONCE', 'ALLOW_SESSION', 'DENY', 'CANCEL'].includes(decision.decision)) throw new EngineError('UI_APPROVAL_DECISION_INVALID');
    const pending = this.#pendingApprovals.get(handle);
    if (pending === undefined) throw new EngineError('UI_APPROVAL_UNCORRELATED');
    if (!pending.availableDecisions.includes(decision.decision)) throw new EngineError('UI_APPROVAL_DECISION_NOT_OFFERED');
    this.#pendingApprovals.delete(handle);
    let result;
    if (pending.method === 'item/permissions/requestApproval') {
      result = decision.decision === 'ALLOW_ONCE'
        ? Object.freeze({ scope: 'turn', permissions: freezeParsedJson(JSON.parse(canonicalJson(pending.params.permissions ?? {}))) })
        : Object.freeze({ scope: 'turn', permissions: Object.freeze({}) });
    } else {
      const mapped = decision.decision === 'ALLOW_ONCE' ? 'accept' : decision.decision === 'ALLOW_SESSION' ? 'acceptForSession' : decision.decision === 'DENY' ? 'decline' : 'cancel';
      result = Object.freeze({ decision: mapped });
    }
    const response = Object.freeze({ id: pending.rpcId, result });
    this.#send(response);
    return response;
  }

  #requireInitialized() { if (!this.#initialized || !this.#initializedNotificationSent) throw new EngineError('CODEX_NOT_INITIALIZED'); }
  #requireThread() { this.#requireInitialized(); if (this.#threadId === null) throw new EngineError('CODEX_THREAD_NOT_ACTIVE'); }
  #requireTurn() { this.#requireThread(); if (this.#turnId === null) throw new EngineError('CODEX_TURN_NOT_ACTIVE'); }

  transportDisconnected() {
    this.#pending.clear();
    this.#pendingApprovals.clear();
    this.#activeItems.clear();
    this.#usedServerRequestIds.clear();
    this.#threadId = null;
    this.#turnId = null;
    this.#initialized = false;
    this.#initializedNotificationSent = false;
  }

  memorySummary() {
    return Object.freeze({ provider: 'CODEX', initialized: this.#initialized, thread_active: this.#threadId !== null, turn_active: this.#turnId !== null, pending_approvals: this.#pendingApprovals.size });
  }
}

const CLAUDE_INIT_KEYS = Object.freeze([
  'type', 'subtype', 'uuid', 'session_id', 'agents', 'apiKeySource', 'betas',
  'claude_code_version', 'cwd', 'tools', 'mcp_servers', 'model', 'permissionMode',
  'slash_commands', 'output_style', 'skills', 'plugins', 'plugin_errors',
  'capabilities', 'mcp_server_errors', 'analytics_disabled', 'product_feedback_disabled',
  'memory_paths', 'fast_mode_state', 'fast_mode_disabled_reason'
]);
const CLAUDE_RESULT_KEYS = Object.freeze([
  'type', 'subtype', 'is_error', 'duration_ms', 'duration_api_ms', 'num_turns',
  'result', 'session_id', 'total_cost_usd', 'usage', 'modelUsage',
  'permission_denials', 'uuid', 'structured_output', 'errors', 'stop_reason',
  'terminal_reason', 'fast_mode_state', 'fast_mode_disabled_reason', 'api_error_status',
  'ttft_ms', 'ttft_stream_ms', 'time_to_request_ms'
]);

export class ClaudeStreamJsonAdapter {
  static #activeSessions = new Set();
  #sessionByHandle = new Map();
  #active = null;

  beginReview(text, resumeHandle = null) {
    if (this.#active !== null || !boundedText(text)) throw new EngineError('CLAUDE_REVIEW_REQUEST_INVALID');
    let sessionId = null;
    if (resumeHandle !== null) {
      sessionId = this.#sessionByHandle.get(resumeHandle);
      if (sessionId === undefined || ClaudeStreamJsonAdapter.#activeSessions.has(sessionId)) throw new EngineError('CLAUDE_SESSION_LEASE_UNAVAILABLE');
      ClaudeStreamJsonAdapter.#activeSessions.add(sessionId);
    }
    this.#active = { sessionId, resumeHandle, initSeen: false, resultSeen: false, resultError: null, deltaCount: 0, deltaEventIds: new Set() };
    return Object.freeze({ type: 'user', message: Object.freeze({ role: 'user', content: text }), parent_tool_use_id: null });
  }

  invocationArguments() {
    if (this.#active === null) throw new EngineError('CLAUDE_REVIEW_NOT_ACTIVE');
    const args = [
      '--safe-mode', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--tools', '', '--strict-mcp-config', '--mcp-config',
      '{"mcpServers":{}}', '--disallowedTools', 'mcp__*', '--permission-mode', 'plan',
      '--disable-slash-commands', '--no-chrome', '--setting-sources', ''
    ];
    if (this.#active.sessionId !== null) args.push('--resume', this.#active.sessionId);
    return Object.freeze(args);
  }

  receive(message) {
    if (this.#active === null) throw new EngineError('CLAUDE_REVIEW_NOT_ACTIVE');
    object(message, 'CLAUDE_STREAM_MESSAGE_INVALID');
    if ('request_id' in message || 'delta_sha256' in message || 'result_sha256' in message) throw new EngineError('CLAUDE_SYNTHETIC_WIRE_FORBIDDEN');
    if (message.type === 'system' && message.subtype === 'init') return this.#init(message);
    if (message.type === 'system' && message.subtype === 'api_retry') throw new EngineError('CLAUDE_PROVIDER_RETRY_FORBIDDEN');
    if (message.type === 'stream_event') return this.#delta(message);
    if (message.type === 'assistant') return this.#assistant(message);
    if (message.type === 'result') return this.#result(message);
    throw new EngineError('CLAUDE_STREAM_TYPE_INVALID');
  }

  #init(message) {
    allowedKeys(message, CLAUDE_INIT_KEYS, ['type', 'subtype', 'session_id', 'tools', 'mcp_servers', 'plugins'], 'CLAUDE_INIT_KEYS_INVALID');
    if (this.#active.initSeen || !providerId(message.session_id) || !Array.isArray(message.tools) || message.tools.length !== 0 || !Array.isArray(message.mcp_servers) || message.mcp_servers.length !== 0 || !Array.isArray(message.plugins) || message.plugins.length !== 0 || ('mcp_server_errors' in message && (!Array.isArray(message.mcp_server_errors) || message.mcp_server_errors.length !== 0)) || ('capabilities' in message && (!Array.isArray(message.capabilities) || message.capabilities.length > 64 || message.capabilities.some((value) => !boundedText(value, 256)))) || ('analytics_disabled' in message && typeof message.analytics_disabled !== 'boolean') || ('product_feedback_disabled' in message && typeof message.product_feedback_disabled !== 'boolean') || ('fast_mode_state' in message && !isSafeToken(message.fast_mode_state, 1, 64)) || ('fast_mode_disabled_reason' in message && !nullableBoundedText(message.fast_mode_disabled_reason, 1024))) throw new EngineError('CLAUDE_INIT_SAFETY_INVALID');
    if ('memory_paths' in message) {
      const memoryPaths = allowedKeys(message.memory_paths, ['auto'], ['auto'], 'CLAUDE_INIT_SAFETY_INVALID');
      if (!boundedText(memoryPaths.auto, 32768)) throw new EngineError('CLAUDE_INIT_SAFETY_INVALID');
    }
    if (this.#active.sessionId !== null && this.#active.sessionId !== message.session_id) throw new EngineError('CLAUDE_SESSION_MISMATCH');
    if (this.#active.sessionId === null) {
      if (ClaudeStreamJsonAdapter.#activeSessions.has(message.session_id)) throw new EngineError('CLAUDE_SESSION_LEASE_UNAVAILABLE');
      ClaudeStreamJsonAdapter.#activeSessions.add(message.session_id);
      this.#active.sessionId = message.session_id;
    }
    this.#active.initSeen = true;
    const handle = `claude_${sha256Text(message.session_id).slice(0, 24)}`;
    this.#sessionByHandle.set(handle, message.session_id);
    return Object.freeze({ provider: 'CLAUDE', event: 'SESSION_READY', handle });
  }

  #correlate(message) {
    if (!this.#active.initSeen || message.session_id !== this.#active.sessionId) throw new EngineError('CLAUDE_STREAM_UNCORRELATED');
  }

  #delta(message) {
    allowedKeys(message, ['type', 'event', 'parent_tool_use_id', 'uuid', 'session_id'], ['type', 'event', 'session_id'], 'CLAUDE_DELTA_KEYS_INVALID');
    this.#correlate(message);
    const event = object(message.event, 'CLAUDE_DELTA_EVENT_INVALID');
    if (typeof event.type !== 'string') throw new EngineError('CLAUDE_DELTA_EVENT_INVALID');
    const eventId = typeof message.uuid === 'string' ? message.uuid : sha256Text(canonicalJson(event));
    if (this.#active.deltaEventIds.has(eventId) || this.#active.resultSeen) throw new EngineError('CLAUDE_DELTA_REPLAY');
    this.#active.deltaEventIds.add(eventId);
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      if (!boundedText(event.delta.text, 262144)) throw new EngineError('CLAUDE_TEXT_DELTA_INVALID');
      this.#active.deltaCount += 1;
      return Object.freeze({ provider: 'CLAUDE', event: 'TEXT_DELTA', text: event.delta.text, text_sha256: sha256Text(event.delta.text) });
    }
    return Object.freeze({ provider: 'CLAUDE', event: 'STREAM_EVENT', event_type: event.type, event_sha256: sha256Text(canonicalJson(event)) });
  }

  #assistant(message) {
    allowedKeys(message, ['type', 'uuid', 'session_id', 'message', 'parent_tool_use_id', 'error'], ['type', 'session_id', 'message'], 'CLAUDE_ASSISTANT_KEYS_INVALID');
    this.#correlate(message);
    return Object.freeze({ provider: 'CLAUDE', event: 'ASSISTANT_MESSAGE', message_sha256: sha256Text(canonicalJson(message.message)) });
  }

  #result(message) {
    allowedKeys(message, CLAUDE_RESULT_KEYS, ['type', 'subtype', 'is_error', 'num_turns', 'result', 'session_id', 'permission_denials'], 'CLAUDE_RESULT_KEYS_INVALID');
    this.#correlate(message);
    if (this.#active.resultSeen || typeof message.is_error !== 'boolean' || typeof message.subtype !== 'string' || typeof message.result !== 'string' || !Number.isSafeInteger(message.num_turns) || message.num_turns < 1 || !Array.isArray(message.permission_denials) || message.permission_denials.length !== 0) throw new EngineError('CLAUDE_RESULT_INVALID');
    this.#active.resultSeen = true;
    this.#active.resultError = message.is_error;
    return Object.freeze({ provider: 'CLAUDE', event: 'RESULT', is_error: message.is_error, subtype: message.subtype, text: message.result, result_sha256: sha256Text(message.result), delta_count: this.#active.deltaCount });
  }

  finish(exitCode) {
    if (this.#active === null || !Number.isInteger(exitCode)) throw new EngineError('CLAUDE_STREAM_FINISH_INVALID');
    if (!this.#active.resultSeen || (exitCode === 0) === this.#active.resultError) {
      this.abort();
      throw new EngineError('CLAUDE_STREAM_EXIT_INVALID');
    }
    const summary = Object.freeze({ provider: 'CLAUDE', event: 'STREAM_FINISHED', exit_code: exitCode });
    ClaudeStreamJsonAdapter.#activeSessions.delete(this.#active.sessionId);
    this.#active = null;
    return summary;
  }

  abort() {
    if (this.#active !== null && this.#active.sessionId !== null) ClaudeStreamJsonAdapter.#activeSessions.delete(this.#active.sessionId);
    this.#active = null;
  }

  memorySummary() { return Object.freeze({ provider: 'CLAUDE', review_active: this.#active !== null, session_active: this.#active?.sessionId !== null }); }
}
