import { BridgeError } from '../vendor/bridge/util.mjs';
import { sha256Text } from '../vendor/engine/util.mjs';

const ROUTE_LINES = Object.freeze({
  'FLUENS_PROVIDER=CODEX': 'CODEX',
  'FLUENS_PROVIDER=CLAUDE': 'CLAUDE'
});

function firstLine(value) {
  const boundary = value.indexOf('\n');
  return boundary < 0 ? value : value.slice(0, boundary);
}

export function selectProvider(config, petition) {
  const mapped = config.agent_provider_map[petition.agenteId];
  const instruction = ROUTE_LINES[firstLine(petition.instruccionBase)];
  const provider = mapped ?? instruction ?? config.default_provider;
  if (!config.providers[provider]?.enabled) throw new BridgeError('PROVIDER_DISABLED');
  return provider;
}

function framed(label, value) {
  return `${label}_UTF8_BYTES=${Buffer.byteLength(value, 'utf8')}\n<<<${label}\n${value}\n${label}>>>\n`;
}

export function buildDeterministicPrompt(petition, provider) {
  if (!['CODEX', 'CLAUDE'].includes(provider)) throw new BridgeError('PROMPT_PROVIDER_INVALID');
  const lines = [
    'FLUENS_LOCAL_PROVIDER_PROMPT_V1',
    'SAFETY_MODE=TEXT_ONLY_NO_TOOLS_NO_FILE_CHANGES_NO_NETWORK_NO_GOVERNANCE_ACTION',
    'RESPONSE_REQUIREMENT=RETURN_TEXT_ONLY',
    `PROVIDER=${provider}`,
    `AGENT_ID=${petition.agenteId}`,
    `CHAT_ID=${petition.chatId}`,
    `TRIM_APPLIED=${petition.recorte.aplicado ? 'True' : 'False'}`,
    `TRIMMED_MESSAGE_COUNT=${petition.recorte.mensajesOmitidos}`,
    framed('INSTRUCTION', petition.instruccionBase).trimEnd(),
    `BLOCK_COUNT=${petition.bloques.length}`
  ];
  petition.bloques.forEach((block, index) => {
    lines.push(`BLOCK_INDEX=${index}`);
    lines.push(`BLOCK_PASS_ID=${block.paseId}`);
    lines.push(framed('BLOCK_ORIGIN', block.origen).trimEnd());
    lines.push(framed('BLOCK_TEXT', block.texto).trimEnd());
  });
  lines.push(`MESSAGE_COUNT=${petition.mensajes.length}`);
  petition.mensajes.forEach((message, index) => {
    lines.push(`MESSAGE_INDEX=${index}`);
    lines.push(`MESSAGE_ROLE=${message.rol}`);
    lines.push(`MESSAGE_CREATED=${String(message.creado)}`);
    lines.push(framed('MESSAGE_TEXT', message.texto).trimEnd());
  });
  const prompt = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(prompt, 'utf8') > 1048576 || prompt.includes('\0')) throw new BridgeError('PROMPT_LIMIT_INVALID');
  return Object.freeze({ text: prompt, sha256: sha256Text(prompt), provider });
}
