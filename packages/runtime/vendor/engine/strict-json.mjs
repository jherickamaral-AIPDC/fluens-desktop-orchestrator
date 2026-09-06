import { EngineError } from './util.mjs';

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export function parseStrictJson(text, options = {}) {
  const maximumBytes = options.maximumBytes ?? 65536;
  const maximumDepth = options.maximumDepth ?? 32;
  const maximumNumberDigits = options.maximumNumberDigits ?? 15;
  if (typeof text !== 'string' || text.length === 0) {
    throw new EngineError('JSON_EMPTY');
  }
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new EngineError('JSON_OVERSIZE');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new EngineError('JSON_BOM_FORBIDDEN');
  }
  if (text.includes('\0') || text.includes('\r') || text.includes('\n')) {
    throw new EngineError('JSON_LINE_FRAMING_INVALID');
  }

  let index = 0;
  let nodes = 0;
  const maximumNodes = options.maximumNodes ?? 4096;

  function fail(code) {
    throw new EngineError(code);
  }

  function skipWhitespace() {
    while (text[index] === ' ' || text[index] === '\t') index += 1;
  }

  function countNode() {
    nodes += 1;
    if (nodes > maximumNodes) fail('JSON_NODE_LIMIT');
  }

  function parseString(isKey = false) {
    if (text[index] !== '"') fail('JSON_STRING_EXPECTED');
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code < 0x20) fail('JSON_STRING_CONTROL');
      if (text[index] === '"') {
        index += 1;
        const raw = text.slice(start, index);
        if (isKey && escaped) fail('JSON_ESCAPED_KEY_FORBIDDEN');
        let value;
        try { value = JSON.parse(raw); }
        catch { fail('JSON_STRING_INVALID'); }
        for (let cursor = 0; cursor < value.length; cursor += 1) {
          const unit = value.charCodeAt(cursor);
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(cursor + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail('JSON_UNPAIRED_SURROGATE');
            cursor += 1;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            fail('JSON_UNPAIRED_SURROGATE');
          }
        }
        return value;
      }
      if (text[index] === '\\') {
        escaped = true;
        index += 1;
        if (index >= text.length || !'"\\/bfnrtu'.includes(text[index])) fail('JSON_ESCAPE_INVALID');
        if (text[index] === 'u') {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail('JSON_UNICODE_ESCAPE_INVALID');
          index += 4;
        }
      }
      index += 1;
    }
    fail('JSON_STRING_TRUNCATED');
  }

  function parseNumber() {
    const remaining = text.slice(index);
    const match = NUMBER_PATTERN.exec(remaining);
    if (!match) fail('JSON_NUMBER_INVALID');
    const token = match[0];
    index += token.length;
    if (/[eE]/.test(token)) fail('JSON_NUMBER_EXPONENT_FORBIDDEN');
    if (/^-0(?:\.0+)?$/.test(token)) fail('JSON_NEGATIVE_ZERO_FORBIDDEN');
    const digitCount = (token.match(/\d/g) ?? []).length;
    if (digitCount > maximumNumberDigits) fail('JSON_NUMBER_PRECISION_EXCEEDED');
    const value = Number(token);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail('JSON_NUMBER_RANGE_INVALID');
    }
    return value;
  }

  function parseValue(depth) {
    if (depth > maximumDepth) fail('JSON_DEPTH_LIMIT');
    skipWhitespace();
    countNode();
    const current = text[index];
    if (current === '{') return parseObject(depth + 1);
    if (current === '[') return parseArray(depth + 1);
    if (current === '"') return parseString(false);
    if (current === '-' || (current >= '0' && current <= '9')) return parseNumber();
    if (text.startsWith('true', index)) { index += 4; return true; }
    if (text.startsWith('false', index)) { index += 5; return false; }
    if (text.startsWith('null', index)) { index += 4; return null; }
    fail('JSON_VALUE_INVALID');
  }

  function parseObject(depth) {
    index += 1;
    skipWhitespace();
    const result = Object.create(null);
    const exact = new Set();
    const folded = new Set();
    if (text[index] === '}') { index += 1; return result; }
    while (index < text.length) {
      skipWhitespace();
      const key = parseString(true);
      if (exact.has(key)) fail('JSON_DUPLICATE_KEY');
      const lower = key.toLowerCase();
      if (folded.has(lower)) fail('JSON_KEY_CASE_COLLISION');
      exact.add(key);
      folded.add(lower);
      skipWhitespace();
      if (text[index] !== ':') fail('JSON_COLON_EXPECTED');
      index += 1;
      result[key] = parseValue(depth);
      skipWhitespace();
      if (text[index] === '}') { index += 1; return result; }
      if (text[index] !== ',') fail('JSON_OBJECT_DELIMITER_INVALID');
      index += 1;
    }
    fail('JSON_OBJECT_TRUNCATED');
  }

  function parseArray(depth) {
    index += 1;
    skipWhitespace();
    const result = [];
    if (text[index] === ']') { index += 1; return result; }
    while (index < text.length) {
      result.push(parseValue(depth));
      skipWhitespace();
      if (text[index] === ']') { index += 1; return result; }
      if (text[index] !== ',') fail('JSON_ARRAY_DELIMITER_INVALID');
      index += 1;
    }
    fail('JSON_ARRAY_TRUNCATED');
  }

  const value = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail('JSON_TRAILING_CONTENT');
  return value;
}

export function decodeStrictUtf8(buffer, maximumBytes = 65536) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new EngineError('NDJSON_EMPTY_LINE');
  if (buffer.length > maximumBytes) throw new EngineError('NDJSON_LINE_OVERSIZE');
  if (buffer.includes(0x00) || buffer.includes(0x0d) || buffer.includes(0x0a)) {
    throw new EngineError('NDJSON_LINE_FRAMING_INVALID');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new EngineError('NDJSON_UTF8_INVALID');
  }
}
