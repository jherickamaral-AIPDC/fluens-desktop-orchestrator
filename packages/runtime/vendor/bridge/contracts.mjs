import { assertExactKeys, BridgeError, isPlainObject, isSafeId } from './util.mjs';

export const API_PREFIX = '/__fluens_motor/v1/';
export const SCHEMAS = Object.freeze({
  status: 'FLUENS_UI_MOTOR_STATUS_V1',
  statusRequest: 'FLUENS_UI_MOTOR_STATUS_REQUEST_V1',
  create: 'FLUENS_UI_MOTOR_CREATE_V1',
  createResponse: 'FLUENS_UI_MOTOR_CREATE_RESPONSE_V1',
  poll: 'FLUENS_UI_MOTOR_POLL_V1',
  pollResponse: 'FLUENS_UI_MOTOR_POLL_RESPONSE_V1',
  cancel: 'FLUENS_UI_MOTOR_CANCEL_V1',
  cancelResponse: 'FLUENS_UI_MOTOR_CANCEL_RESPONSE_V1',
  error: 'FLUENS_UI_MOTOR_ERROR_V1'
});

export function assertStatus(value) {
  assertExactKeys(value, ['schema'], 'STATUS_KEYS_INVALID');
  if (value.schema !== SCHEMAS.statusRequest) throw new BridgeError('STATUS_SCHEMA_INVALID');
  return value;
}

export const LIMITS = Object.freeze({
  bodyBytes: 131072,
  instructionBytes: 65536,
  blocks: 64,
  blockOriginBytes: 512,
  blockTextBytes: 32768,
  messages: 512,
  messageTextBytes: 40960,
  totalTextBytes: 110000,
  tokenBytes: 4096,
  outputBytes: 65536,
  events: 128,
  eventsPerPoll: 16,
  metadataEntries: 512
});

function boundedText(value, maximumBytes, code, allowEmpty = true) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new BridgeError(code);
  }
  return value;
}

function safeId(value, code) {
  if (!isSafeId(value, 96)) throw new BridgeError(code);
  return value;
}

export function assertPetition(value) {
  assertExactKeys(value, ['peticionId', 'agenteId', 'chatId', 'instruccionBase', 'bloques', 'mensajes', 'recorte'], 'PETITION_KEYS_INVALID');
  safeId(value.peticionId, 'PETITION_ID_INVALID');
  safeId(value.agenteId, 'AGENT_ID_INVALID');
  safeId(value.chatId, 'CHAT_ID_INVALID');
  boundedText(value.instruccionBase, LIMITS.instructionBytes, 'INSTRUCTION_INVALID');
  if (!Array.isArray(value.bloques) || value.bloques.length > LIMITS.blocks) throw new BridgeError('BLOCKS_INVALID');
  if (!Array.isArray(value.mensajes) || value.mensajes.length > LIMITS.messages) throw new BridgeError('MESSAGES_INVALID');
  let total = Buffer.byteLength(value.instruccionBase, 'utf8');
  for (const block of value.bloques) {
    assertExactKeys(block, ['paseId', 'origen', 'texto'], 'BLOCK_KEYS_INVALID');
    safeId(block.paseId, 'PASS_ID_INVALID');
    boundedText(block.origen, LIMITS.blockOriginBytes, 'BLOCK_ORIGIN_INVALID');
    boundedText(block.texto, LIMITS.blockTextBytes, 'BLOCK_TEXT_INVALID');
    total += Buffer.byteLength(block.origen, 'utf8') + Buffer.byteLength(block.texto, 'utf8');
  }
  for (const message of value.mensajes) {
    assertExactKeys(message, ['rol', 'texto', 'creado'], 'MESSAGE_KEYS_INVALID');
    if (!['usuario', 'agente'].includes(message.rol)) throw new BridgeError('MESSAGE_ROLE_INVALID');
    boundedText(message.texto, LIMITS.messageTextBytes, 'MESSAGE_TEXT_INVALID');
    if (!(typeof message.creado === 'string' && message.creado.length >= 1 && message.creado.length <= 64) &&
        !(Number.isSafeInteger(message.creado) && message.creado >= 0)) throw new BridgeError('MESSAGE_CREATED_INVALID');
    total += Buffer.byteLength(message.texto, 'utf8');
  }
  assertExactKeys(value.recorte, ['aplicado', 'mensajesOmitidos'], 'TRIM_KEYS_INVALID');
  if (typeof value.recorte.aplicado !== 'boolean' || !Number.isSafeInteger(value.recorte.mensajesOmitidos) || value.recorte.mensajesOmitidos < 0 || value.recorte.mensajesOmitidos > 1000000) {
    throw new BridgeError('TRIM_INVALID');
  }
  if (total > LIMITS.totalTextBytes) throw new BridgeError('PETITION_TEXT_LIMIT');
  return value;
}

export function assertCreate(value) {
  assertExactKeys(value, ['schema', 'peticion'], 'CREATE_KEYS_INVALID');
  if (value.schema !== SCHEMAS.create) throw new BridgeError('CREATE_SCHEMA_INVALID');
  return assertPetition(value.peticion);
}

export function assertPoll(value) {
  assertExactKeys(value, ['schema', 'peticion_id', 'chat_id', 'binding_sha256', 'cursor', 'poll_sequence'], 'POLL_KEYS_INVALID');
  if (value.schema !== SCHEMAS.poll) throw new BridgeError('POLL_SCHEMA_INVALID');
  safeId(value.peticion_id, 'POLL_REQUEST_ID_INVALID');
  safeId(value.chat_id, 'POLL_CHAT_ID_INVALID');
  if (typeof value.binding_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.binding_sha256) || /^0{64}$/.test(value.binding_sha256)) throw new BridgeError('POLL_BINDING_INVALID');
  if (!Number.isSafeInteger(value.cursor) || value.cursor < -1 || value.cursor > 1000000) throw new BridgeError('POLL_CURSOR_INVALID');
  if (!Number.isSafeInteger(value.poll_sequence) || value.poll_sequence < 0 || value.poll_sequence > 1000000) throw new BridgeError('POLL_SEQUENCE_INVALID');
  return value;
}

export function assertCancel(value) {
  assertExactKeys(value, ['schema', 'peticion_id', 'chat_id', 'binding_sha256'], 'CANCEL_KEYS_INVALID');
  if (value.schema !== SCHEMAS.cancel) throw new BridgeError('CANCEL_SCHEMA_INVALID');
  safeId(value.peticion_id, 'CANCEL_REQUEST_ID_INVALID');
  safeId(value.chat_id, 'CANCEL_CHAT_ID_INVALID');
  if (typeof value.binding_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.binding_sha256) || /^0{64}$/.test(value.binding_sha256)) throw new BridgeError('CANCEL_BINDING_INVALID');
  return value;
}

export function assertConfigObject(value) {
  assertExactKeys(value, ['schema', 'host', 'port', 'ui_root', 'driver', 'request_timeout_ms', 'poll_timeout_ms'], 'CONFIG_KEYS_INVALID');
  if (value.schema !== 'FLUENS_UI_BRIDGE_CONFIG_V1' || value.host !== '127.0.0.1' || value.driver !== 'mock-disabled') throw new BridgeError('CONFIG_VALUE_INVALID');
  if (!Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535) throw new BridgeError('CONFIG_PORT_INVALID');
  if (typeof value.ui_root !== 'string' || !value.ui_root || !isPlainObject(value) || value.ui_root.includes('\0')) throw new BridgeError('CONFIG_UI_ROOT_INVALID');
  if (!Number.isSafeInteger(value.request_timeout_ms) || value.request_timeout_ms < 100 || value.request_timeout_ms > 300000) throw new BridgeError('CONFIG_REQUEST_TIMEOUT_INVALID');
  if (!Number.isSafeInteger(value.poll_timeout_ms) || value.poll_timeout_ms < 10 || value.poll_timeout_ms > 5000) throw new BridgeError('CONFIG_POLL_TIMEOUT_INVALID');
  return value;
}
