/* UIBRIDGE001 mock-only browser adapter. No provider/session/runtime identity enters this file. */
(function installFluensMotor(global) {
  'use strict';

  var API = '/__fluens_motor/v1/';
  var state = 'ausente';
  var active = null;
  var probing = false;
  var quarantineRecovery = false;
  var recoveryTimer = null;
  var encoder = new TextEncoder();
  var SERVER_MAX_POLL_TIMEOUT_MS = 5000;
  var POLL_RESPONSE_MARGIN_MS = 1000;
  var DEADLINES = Object.freeze({ status: 500, request: 1000, poll: SERVER_MAX_POLL_TIMEOUT_MS + POLL_RESPONSE_MARGIN_MS, cancel: 1000 });

  function fail(code) { var error = new Error(code); error.code = code; throw error; }
  function bytes(text) { return encoder.encode(text).length; }
  function keysExact(value, expected) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RESPONSE_OBJECT_INVALID');
    var actual = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    if (actual.length !== wanted.length) fail('RESPONSE_KEYS_INVALID');
    for (var i = 0; i < actual.length; i += 1) if (actual[i] !== wanted[i]) fail('RESPONSE_KEYS_INVALID');
  }

  function strictParse(text) {
    if (typeof text !== 'string' || text.length < 2 || bytes(text) > 131072 || /[\u0000\r\n]/.test(text)) fail('RESPONSE_JSON_INVALID');
    var index = 0;
    var nodes = 0;
    function white() { while (text[index] === ' ' || text[index] === '\t') index += 1; }
    function string(key) {
      if (text[index] !== '"') fail('RESPONSE_JSON_INVALID');
      var start = index++;
      var escaped = false;
      while (index < text.length) {
        var code = text.charCodeAt(index);
        if (code < 32) fail('RESPONSE_JSON_INVALID');
        if (text[index] === '"') {
          index += 1;
          if (key && escaped) fail('RESPONSE_JSON_INVALID');
          try { return JSON.parse(text.slice(start, index)); } catch (_) { fail('RESPONSE_JSON_INVALID'); }
        }
        if (text[index] === '\\') {
          escaped = true;
          index += 1;
          if (index >= text.length || '"\\/bfnrtu'.indexOf(text[index]) < 0) fail('RESPONSE_JSON_INVALID');
          if (text[index] === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail('RESPONSE_JSON_INVALID');
            index += 4;
          }
        }
        index += 1;
      }
      fail('RESPONSE_JSON_INVALID');
    }
    function number() {
      var match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(text.slice(index));
      if (!match) fail('RESPONSE_JSON_INVALID');
      index += match[0].length;
      if ((match[0].match(/\d/g) || []).length > 15 || /^-0(?:\.0+)?$/.test(match[0])) fail('RESPONSE_JSON_INVALID');
      var value = Number(match[0]);
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('RESPONSE_JSON_INVALID');
      return value;
    }
    function value(depth) {
      if (depth > 12 || ++nodes > 4096) fail('RESPONSE_JSON_INVALID');
      white();
      if (text[index] === '{') return object(depth + 1);
      if (text[index] === '[') return array(depth + 1);
      if (text[index] === '"') return string(false);
      if (text[index] === '-' || /[0-9]/.test(text[index])) return number();
      if (text.slice(index, index + 4) === 'true') { index += 4; return true; }
      if (text.slice(index, index + 5) === 'false') { index += 5; return false; }
      if (text.slice(index, index + 4) === 'null') { index += 4; return null; }
      fail('RESPONSE_JSON_INVALID');
    }
    function object(depth) {
      index += 1; white();
      var result = Object.create(null); var exact = Object.create(null); var folded = Object.create(null);
      if (text[index] === '}') { index += 1; return result; }
      while (index < text.length) {
        white(); var key = string(true); var lower = key.toLowerCase();
        if (exact[key] || folded[lower]) fail('RESPONSE_JSON_INVALID');
        exact[key] = true; folded[lower] = true; white();
        if (text[index++] !== ':') fail('RESPONSE_JSON_INVALID');
        result[key] = value(depth); white();
        if (text[index] === '}') { index += 1; return result; }
        if (text[index++] !== ',') fail('RESPONSE_JSON_INVALID');
      }
      fail('RESPONSE_JSON_INVALID');
    }
    function array(depth) {
      index += 1; white(); var result = [];
      if (text[index] === ']') { index += 1; return result; }
      while (index < text.length) {
        result.push(value(depth)); white();
        if (text[index] === ']') { index += 1; return result; }
        if (text[index++] !== ',') fail('RESPONSE_JSON_INVALID');
      }
      fail('RESPONSE_JSON_INVALID');
    }
    var result = value(0); white(); if (index !== text.length) fail('RESPONSE_JSON_INVALID'); return result;
  }

  async function post(route, body) {
    if (!Object.prototype.hasOwnProperty.call(DEADLINES, route) || typeof global.AbortController !== 'function') fail('BRIDGE_DEADLINE_INVALID');
    var controller = new global.AbortController();
    var timer;
    var timeout = new Promise(function (_resolve, reject) {
      timer = global.setTimeout(function () {
        controller.abort();
        var error = new Error('BRIDGE_TIMEOUT');
        error.code = 'BRIDGE_TIMEOUT';
        reject(error);
      }, DEADLINES[route]);
    });
    try {
      var response = await Promise.race([global.fetch(API + route, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      }), timeout]);
      var parsed = strictParse(await Promise.race([response.text(), timeout]));
      if (!response.ok) {
        keysExact(parsed, ['schema', 'error']);
        if (parsed.schema !== 'FLUENS_UI_MOTOR_ERROR_V1' || typeof parsed.error !== 'string') fail('BRIDGE_REJECTED');
        fail(parsed.error);
      }
      return parsed;
    } finally { global.clearTimeout(timer); }
  }

  function safeCallback(fn, value) {
    try { fn(value); } catch (_) { /* UI callback failures never reenter the bridge. */ }
  }

  function settle(context, kind, value, bridgeLost) {
    if (active !== context || context.terminal) return;
    context.terminal = true;
    active = null;
    var quarantined = kind === 'error' && value === 'DRIVER_DRAIN_TIMEOUT';
    quarantineRecovery = quarantined;
    state = bridgeLost || quarantined ? 'ausente' : 'listo';
    if (kind === 'finished') safeCallback(context.onFin, value);
    else safeCallback(context.onError, value);
    if (quarantined) scheduleRecoveryProbe();
  }

  function validateBinding(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value);
  }

  async function poll(context) {
    while (active === context && !context.terminal) {
      var response = await post('poll', {
        schema: 'FLUENS_UI_MOTOR_POLL_V1',
        peticion_id: context.id,
        chat_id: context.chatId,
        binding_sha256: context.binding,
        cursor: context.cursor,
        poll_sequence: context.pollSequence
      });
      keysExact(response, ['schema', 'binding_sha256', 'events', 'poll_sequence', 'terminal']);
      if (response.schema !== 'FLUENS_UI_MOTOR_POLL_RESPONSE_V1' || response.binding_sha256 !== context.binding || response.poll_sequence !== context.pollSequence || !Array.isArray(response.events) || typeof response.terminal !== 'boolean' || response.events.length > 16) fail('POLL_RESPONSE_INVALID');
      var staged = [];
      var stagedCursor = context.cursor;
      var stagedOutputBytes = context.outputBytes;
      var sawTerminal = false;
      for (var i = 0; i < response.events.length; i += 1) {
        var event = response.events[i];
        if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.cursor) || event.cursor !== stagedCursor + 1) fail('EVENT_CURSOR_INVALID');
        stagedCursor = event.cursor;
        if (event.kind === 'token') {
          keysExact(event, ['cursor', 'kind', 'text']);
          var tokenBytes = typeof event.text === 'string' ? bytes(event.text) : -1;
          if (typeof event.text !== 'string' || event.text.length === 0 || tokenBytes > 4096 || stagedOutputBytes + tokenBytes > 65536) fail('TOKEN_INVALID');
          stagedOutputBytes += tokenBytes;
          staged.push({ kind: 'token', value: event.text });
        } else if (event.kind === 'finished') {
          keysExact(event, ['cursor', 'kind', 'text']);
          if (typeof event.text !== 'string' || bytes(event.text) > 65536) fail('OUTPUT_INVALID');
          sawTerminal = true;
          staged.push({ kind: 'finished', value: event.text });
        } else if (event.kind === 'error' || event.kind === 'cancelled') {
          keysExact(event, ['cursor', 'kind', 'code']);
          if (typeof event.code !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(event.code)) fail('ERROR_CODE_INVALID');
          sawTerminal = true;
          staged.push({ kind: 'error', value: event.code });
        } else fail('EVENT_KIND_INVALID');
        if (sawTerminal && i !== response.events.length - 1) fail('EVENT_AFTER_TERMINAL');
      }
      if (response.terminal !== sawTerminal) fail('POLL_TERMINAL_INVALID');
      if (active !== context || context.terminal) return;
      context.cursor = stagedCursor;
      context.pollSequence += 1;
      context.outputBytes = stagedOutputBytes;
      for (var stagedIndex = 0; stagedIndex < staged.length; stagedIndex += 1) {
        var stagedEvent = staged[stagedIndex];
        if (stagedEvent.kind === 'token') safeCallback(context.onToken, stagedEvent.value);
        else settle(context, stagedEvent.kind, stagedEvent.value, false);
      }
      if (!sawTerminal) await new Promise(function pause(resolve) { global.setTimeout(resolve, 5); });
    }
  }

  async function createAndPoll(context, petition) {
    try {
      var response = await post('request', { schema: 'FLUENS_UI_MOTOR_CREATE_V1', peticion: petition });
      keysExact(response, ['schema', 'accepted', 'binding_sha256']);
      if (response.schema !== 'FLUENS_UI_MOTOR_CREATE_RESPONSE_V1' || response.accepted !== true || !validateBinding(response.binding_sha256)) fail('CREATE_RESPONSE_INVALID');
      if (active !== context || context.terminal) return;
      context.binding = response.binding_sha256;
      if (context.cancelRequested) await issueCancel(context);
      await poll(context);
    } catch (error) {
      if (context.binding && !context.cancelSent && active === context && !context.terminal) {
        try { await issueCancel(context); } catch (_) { /* One bounded cleanup attempt only. */ }
      }
      settle(context, 'error', error && /^[A-Z0-9_]{3,80}$/.test(error.code) ? error.code : 'BRIDGE_UNAVAILABLE', true);
    }
  }

  async function issueCancel(context) {
    if (context.cancelSent || !context.binding || active !== context || context.terminal) return;
    context.cancelSent = true;
    var response = await post('cancel', {
      schema: 'FLUENS_UI_MOTOR_CANCEL_V1',
      peticion_id: context.id,
      chat_id: context.chatId,
      binding_sha256: context.binding
    });
    keysExact(response, ['schema', 'binding_sha256', 'terminal']);
    if (response.schema !== 'FLUENS_UI_MOTOR_CANCEL_RESPONSE_V1' || response.binding_sha256 !== context.binding || response.terminal !== true) fail('CANCEL_RESPONSE_INVALID');
  }

  function projectPetition(petition) {
    if (!petition || typeof petition !== 'object' || Array.isArray(petition)) fail('PETITION_INVALID');
    var actual = Object.keys(petition).sort();
    var base = ['agenteId', 'bloques', 'chatId', 'instruccionBase', 'mensajes', 'peticionId', 'recorte'].sort();
    var withReferences = base.concat(['referencias']).sort();
    var valid = (actual.length === base.length && actual.every(function (key, index) { return key === base[index]; })) ||
      (actual.length === withReferences.length && actual.every(function (key, index) { return key === withReferences[index]; }) && Array.isArray(petition.referencias) && petition.referencias.length <= 128);
    if (!valid) fail('PETITION_KEYS_INVALID');
    return {
      peticionId: petition.peticionId,
      agenteId: petition.agenteId,
      chatId: petition.chatId,
      instruccionBase: petition.instruccionBase,
      bloques: petition.bloques,
      mensajes: petition.mensajes,
      recorte: petition.recorte
    };
  }

  function scheduleRecoveryProbe() {
    if (!quarantineRecovery || active || recoveryTimer !== null) return;
    recoveryTimer = global.setTimeout(function recover() {
      recoveryTimer = null;
      if (quarantineRecovery && !active) probe();
    }, 100);
  }

  function probe() {
    if (probing || active) return;
    probing = true;
    post('status', { schema: 'FLUENS_UI_MOTOR_STATUS_REQUEST_V1' }).then(function (response) {
      keysExact(response, ['schema', 'estado', 'title_proposals', 'automatic_passes']);
      if (response.schema !== 'FLUENS_UI_MOTOR_STATUS_V1' || ['listo', 'ocupado'].indexOf(response.estado) < 0 || response.title_proposals !== false || response.automatic_passes !== false) fail('STATUS_RESPONSE_INVALID');
      if (!active) {
        state = response.estado;
        if (response.estado === 'listo') quarantineRecovery = false;
      }
    }).catch(function () { if (!active) state = 'ausente'; }).finally(function () {
      probing = false;
      if (quarantineRecovery && !active) scheduleRecoveryProbe();
    });
  }

  global.FluensMotor = Object.freeze({
    estado: function estado() {
      if (!active && state !== 'listo') probe();
      return state;
    },
    enviar: function enviar(peticion, callbacks) {
      var id = peticion && typeof peticion.peticionId === 'string' ? peticion.peticionId : '';
      var onError = callbacks && typeof callbacks.onError === 'function' ? callbacks.onError : function () {};
      if (!callbacks || typeof callbacks.onFin !== 'function' || (callbacks.onToken !== undefined && typeof callbacks.onToken !== 'function')) {
        global.setTimeout(function () { safeCallback(onError, 'CALLBACKS_INVALID'); }, 0);
        return id;
      }
      if (state !== 'listo' || active) {
        global.setTimeout(function () { safeCallback(onError, state === 'ocupado' || active ? 'MOTOR_OCUPADO' : 'MOTOR_AUSENTE'); }, 0);
        return id;
      }
      var projected;
      try { projected = projectPetition(peticion); }
      catch (_) { global.setTimeout(function () { safeCallback(onError, 'PETITION_INVALID'); }, 0); return id; }
      var context = {
        id: projected.peticionId,
        chatId: projected.chatId,
        binding: null,
        cursor: -1,
        pollSequence: 0,
        outputBytes: 0,
        terminal: false,
        cancelRequested: false,
        cancelSent: false,
        onToken: callbacks.onToken || function () {},
        onFin: callbacks.onFin,
        onError: onError
      };
      active = context;
      state = 'ocupado';
      void createAndPoll(context, projected);
      return id;
    },
    cancelar: function cancelar(peticionId) {
      var context = active;
      if (!context || context.terminal || context.id !== peticionId || context.cancelRequested) return;
      context.cancelRequested = true;
      if (context.binding) void issueCancel(context).catch(function () { settle(context, 'error', 'BRIDGE_UNAVAILABLE', true); });
    }
  });
  probe();
})(window);
