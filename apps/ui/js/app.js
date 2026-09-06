/* ============================================================================
   app.js — interfaz de Fluens Orquestador
   ----------------------------------------------------------------------------
   PRINCIPIO RECTOR
   Cero fricción entre pensar y escribir; cero pérdida entre escribir y volver
   a encontrarlo. Si un elemento no acelera el trabajo diario ni protege un
   dato ya escrito, no está aquí.

   MODIFICADOR: Alt.  El navegador se queda con Ctrl+N, Ctrl+T, Ctrl+W,
   Ctrl+1..9, Ctrl+K... Ninguna función de esta aplicación depende de ganarle
   una tecla al navegador.
   ========================================================================== */

(function () {
  'use strict';

  const F = window.Fluens;
  const MD = window.FluensMD;
  const $ = (id) => document.getElementById(id);

  // Que este script se ejecute ya demuestra que el navegador NO ha bloqueado
  // los scripts, así que el aviso estático de "no se puede abrir con doble
  // clic" sobra y se sustituye.
  try {
    $('boot-msg').textContent = 'Iniciando…';
    $('boot-help').hidden = true;
  } catch (_) { }

  /* ------------------------------------------------------------- ESTADO */

  const S = {
    agentes: [],
    agenteActivo: null,
    chats: [],
    chatActivo: null,
    mensajes: [],
    ventana: 80,          // mensajes visibles desde el final
    focoMsgId: null,
    marcados: new Set(),
    bandejas: new Map(),
    ui: null,
    zona: 'composer',
    soloLectura: false,
    deshacer: null,       // { txt, fn, hasta }
    avisoTimer: null,
    guardadoTs: null,
    ultimaCopia: null,
    desdeUltimaCopia: 0,
    gruposCerrados: new Set(),
    ensamblajesAbiertos: new Set(),
    filtroLista: '',
    filtroRail: '',
    resaltar: null,
    canal: null,
    dirCopia: null
  };

  const VENTANA_DESHACER = 10000;

  /* ---------------------------------------------------------- UTILIDADES */

  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto != null) e.textContent = texto;
    return e;
  }
  function vaciar(nodo) { while (nodo.firstChild) nodo.removeChild(nodo.firstChild); }

  function aviso(txt, alerta) {
    const n = $('st-aviso');
    n.textContent = txt || '';
    n.classList.toggle('alerta', !!alerta);
    clearTimeout(S.avisoTimer);
    if (txt) S.avisoTimer = setTimeout(() => { n.textContent = ''; n.classList.remove('alerta'); }, 9000);
  }

  function ofrecerDeshacer(txt, fn) {
    S.deshacer = { txt, fn, hasta: Date.now() + VENTANA_DESHACER };
    aviso(txt + ' — Alt+Z para deshacer');
  }

  async function conError(etiqueta, fn) {
    try { return await fn(); }
    catch (e) {
      console.error(etiqueta, e);
      await F.errores.registrar(etiqueta, e, location.href);
      aviso('error: ' + (e && e.message ? e.message : e) + ' — Alt+. › Errores', true);
      return null;
    }
  }

  function bloqueado() {
    if (S.soloLectura) { aviso('solo lectura — otra ventana tiene el mando', true); return true; }
    return false;
  }

  function anunciar(que) {
    if (S.canal) { try { S.canal.postMessage({ que, ts: Date.now() }); } catch (_) { } }
  }

  function marcarGuardado() {
    S.guardadoTs = Date.now();
    pintarEstado();
  }

  /* ================================================================ ARRANQUE */

  async function init() {
    const bootMsg = $('boot-msg');

    if (!window.indexedDB || location.protocol === 'file:') {
      bootMsg.textContent = 'Esta aplicación no puede abrirse con doble clic.';
      $('boot-help').hidden = false;
      return;
    }

    try {
      await F.abrir();
    } catch (e) {
      bootMsg.textContent = 'No se pudo abrir la base de datos: ' + e.message;
      $('boot-help').hidden = false;
      return;
    }

    try {
      await F.mantenimiento.persistir();
      await tomarMando();

      S.ui = await F.estado.leer();
      S.agentes = await F.agentes.listar();

      if (!S.agentes.length) await sembrar();
      if (!S.agentes.some(a => a.esMemoria)) await crearAgenteMemoria();

      S.canal = ('BroadcastChannel' in window) ? new BroadcastChannel('fluens') : null;
      if (S.canal) S.canal.onmessage = (ev) => refrescarPorOtraVentana(ev.data && ev.data.que);

      S.bandejas = await F.pases.contarBandejas();
      S.ultimaCopia = await F.copias.ultima();
      S.dirCopia = S.ui.dirCopia || null;

      // Memoria ocupa la ranura 0, pero no es donde se trabaja: al abrir en
      // frío se aterriza en el primer agente real, no en la hoja de consulta.
      const agId = S.ui.agenteActivoId && S.agentes.find(a => a.id === S.ui.agenteActivoId)
        ? S.ui.agenteActivoId
        : (S.agentes.find(a => !a.esMemoria) || S.agentes[0]).id;

      $('boot').hidden = true;
      $('app').hidden = false;

      cablear();
      await irAgente(agId, true);

      if ($('app').classList && S.ui.listaColapsada) $('app').classList.add('sin-lista');

      // Copia al arrancar (y a partir de ahí, cada 50 mensajes y al cerrar).
      copiaAutomatica('arranque');
    } catch (e) {
      console.error('arranque', e);
      bootMsg.textContent = 'Fallo al arrancar: ' + (e && e.message ? e.message : e);
      $('boot-help').hidden = false;
      try { await F.errores.registrar('arranque', e, ''); } catch (_) { }
    }
  }

  async function sembrar() {
    // Primer arranque: solo lo imprescindible. Sin datos de ejemplo.
    await F.agentes.crear({
      nombre: 'Sin clasificar', glifo: 'SC', posicion: 1, fijo: true,
      proposito: 'Donde soltar una idea antes de decidir su dominio.',
      instruccionBase: ''
    });
    await F.agentes.crear({
      nombre: 'Trading', glifo: 'TR', posicion: 2,
      instruccionBase: 'Dominio: trading.\n\nEscribe aquí qué cubre este agente y cómo debe responder. Este texto se envía verbatim al motor como instrucción base.'
    });
    await F.agentes.crear({
      nombre: 'Fluens · psicología', glifo: 'FL', posicion: 3,
      instruccionBase: 'Dominio: el proyecto de psicología Fluens.\n\nEscribe aquí qué cubre este agente y cómo debe responder.'
    });
    S.agentes = await F.agentes.listar();
  }

  /* El candado se RETIENE mientras viva la pestaña, así que el callback nunca
     retorna. Por eso no se puede esperar a `locks.request`: hay que resolver
     aparte en cuanto se sabe si tenemos el mando, o el arranque se cuelga. */
  function tomarMando() {
    if (!navigator.locks) { S.soloLectura = false; return Promise.resolve(); }
    return new Promise((listo) => {
      let resuelto = false;
      const decidir = () => { if (!resuelto) { resuelto = true; listo(); } };
      setTimeout(decidir, 1500);   // si Web Locks no responde, seguimos igual

      navigator.locks.request('fluens-escritura', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          S.soloLectura = true;
          decidir();
          // Esperamos el mando en segundo plano, sin bloquear nada.
          navigator.locks.request('fluens-escritura', async () => {
            S.soloLectura = false;
            pintarEstado();
            aviso('mando tomado — esta ventana ya puede escribir');
            await new Promise(() => { });
          });
          return;
        }
        S.soloLectura = false;
        decidir();
        await new Promise(() => { });   // se conserva mientras viva la pestaña
      }).catch(() => { S.soloLectura = false; decidir(); });
    });
  }

  async function refrescarPorOtraVentana(que) {
    if (que === 'agentes') S.agentes = await F.agentes.listar();
    S.bandejas = await F.pases.contarBandejas();
    if (S.agenteActivo) S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
    if (S.chatActivo && !S.chatActivo.virtual) {
      S.mensajes = await F.mensajes.listar(S.chatActivo.id);
    }
    pintarRail(); pintarLista(); pintarHilo(); pintarEstado();
  }

  /* ================================================================ NAVEGAR */

  async function irAgente(id, sinApilar) {
    const a = S.agentes.find(x => x.id === id);
    if (!a) return;
    await guardarBorrador();
    S.agenteActivo = a;
    S.ui.agenteActivoId = id;
    S.chats = await F.chats.listarPorAgente(id);
    S.filtroLista = '';
    $('list-filter').hidden = true;
    $('list-filter').value = '';

    const ultimo = S.ui.ultimoChatPorAgente[id];
    const chat = (ultimo && S.chats.find(c => c.id === ultimo)) || S.chats[0] || null;
    if (chat) await irChat(chat.id, sinApilar);
    else await nuevoChat(true);

    pintarRail();
    pintarLista();
    pintarEstado();
    await guardarUI();
  }

  async function irChat(id, sinApilar) {
    await guardarBorrador();
    const c = S.chats.find(x => x.id === id) || await F.chats.obtener(id);
    if (!c) return;
    if (c.agenteId !== (S.agenteActivo && S.agenteActivo.id)) {
      const a = S.agentes.find(x => x.id === c.agenteId);
      if (a) {
        S.agenteActivo = a;
        S.ui.agenteActivoId = a.id;
        S.chats = await F.chats.listarPorAgente(a.id);
        pintarRail();
      }
    }
    S.chatActivo = c;
    S.mensajes = await F.mensajes.listar(c.id);
    S.ventana = 80;
    S.marcados.clear();
    S.focoMsgId = null;
    S.ui.ultimoChatPorAgente[S.agenteActivo.id] = c.id;

    if (!sinApilar) {
      const d = S.ui.ultimosDosChats.filter(x => x !== c.id);
      d.unshift(c.id);
      S.ui.ultimosDosChats = d.slice(0, 2);
    }

    $('composer').value = c.borrador || '';
    ajustarCompositor();
    pintarLista(); pintarHilo(); pintarEstado();
    setTimeout(() => {
      const sc = $('thread-scroll');
      sc.scrollTop = sc.scrollHeight;
      $('composer').focus();
      const p = $('composer').value.length;
      $('composer').setSelectionRange(p, p);
    }, 0);
    await guardarUI();
  }

  async function nuevoChat(silencioso) {
    // Un chat nuevo no toca el disco, así que se permite incluso en solo
    // lectura: leer y moverse nunca se bloquea, solo escribir.
    await guardarBorrador();
    const c = F.chats.nuevoVirtual(S.agenteActivo.id);
    S.chatActivo = c;
    S.mensajes = [];
    S.marcados.clear();
    S.focoMsgId = null;
    $('composer').value = '';
    ajustarCompositor();
    pintarLista(); pintarHilo(); pintarEstado();
    if (!silencioso) $('composer').focus();
  }

  async function guardarBorrador() {
    const c = S.chatActivo;
    if (!c || S.soloLectura) return;
    const txt = $('composer').value;
    if (c.virtual && !txt.trim()) return;   // se evapora sin dejar rastro
    if (c.borrador === txt) return;
    c.borrador = txt;
    c.borradorCursor = $('composer').selectionStart || 0;
    if (c.virtual) {
      // Excepción que salva texto: hay algo tecleado, se persiste ya.
      c.virtual = false;
      if (!c.titulo) c.titulo = F.chats.tituloAuto(txt.split('\n')[0], c.creado);
      await F.chats.guardar(c);
      S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
      S.ui.ultimoChatPorAgente[S.agenteActivo.id] = c.id;
      pintarLista();
    } else {
      await F.chats.guardar(c);
    }
    marcarGuardado();
  }

  /* ================================================================ PINTAR */

  function pintarRail() {
    const cont = $('rail-list');
    vaciar(cont);
    const filtro = F.sinAcentos(S.filtroRail.toLowerCase());
    for (const a of S.agentes) {
      if (filtro && !F.sinAcentos(a.nombre.toLowerCase()).includes(filtro)) continue;
      const b = el('button', 'agente' + (a.esMemoria ? ' memoria' : ''));
      b.type = 'button';
      if (S.agenteActivo && a.id === S.agenteActivo.id) b.classList.add('activo');
      b.appendChild(el('span', 'idx', a.esMemoria ? '≡' : (a.posicion >= 1 && a.posicion <= 9 ? String(a.posicion) : '')));
      const nom = el('span', 'nom', a.nombre);
      if (a.esMemoria) nom.title = 'Alt+M — recupera de todos los agentes alcanzables; no responde';
      b.appendChild(nom);
      if (!a.esMemoria && a.alcanzablePorMemoria) {
        const pt = el('span', 'alcanzable', '≡');
        pt.title = 'alcanzable por la memoria';
        b.appendChild(pt);
      }
      const bj = S.bandejas.get(a.id);
      if (bj && bj.n) {
        const dias = Math.floor((Date.now() - bj.masViejo) / 86400000);
        const badge = el('span', 'badge', dias >= 1 ? bj.n + ' · ' + dias + 'd' : String(bj.n));
        if (dias >= 7) badge.classList.add('viejo');
        b.appendChild(badge);
      }
      b.onclick = () => irAgente(a.id);
      cont.appendChild(b);
    }
  }

  function grupoDe(ts) {
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const t = hoy.getTime();
    if (ts >= t) return { clave: 'hoy', txt: 'Hoy' };
    if (ts >= t - 86400000) return { clave: 'ayer', txt: 'Ayer' };
    if (ts >= t - 6 * 86400000) return { clave: 'semana', txt: 'Últimos 7 días' };
    const d = new Date(ts);
    if (d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth()) {
      return { clave: 'mes', txt: 'Este mes' };
    }
    const clave = d.getFullYear() + '-' + d.getMonth();
    const txt = F.MESES[d.getMonth()].replace(/^./, s => s.toUpperCase()) + ' ' + d.getFullYear();
    return { clave, txt };
  }

  function pintarLista() {
    $('list-agent-name').textContent = S.agenteActivo ? S.agenteActivo.nombre : '—';

    const bj = S.agenteActivo ? S.bandejas.get(S.agenteActivo.id) : null;
    const fila = $('list-inbox');
    const n = bj ? bj.n : 0;
    const dias = bj ? Math.floor((Date.now() - bj.masViejo) / 86400000) : 0;
    $('inbox-count').textContent = n ? (dias >= 1 ? n + ' · ' + dias + 'd' : String(n)) : '0';
    fila.classList.toggle('lleno', n > 0);
    fila.classList.toggle('viejo', n > 0 && dias >= 7);

    const cont = $('list-scroll');
    vaciar(cont);

    const filtro = F.sinAcentos(S.filtroLista.toLowerCase());
    let lista = S.chats.slice();
    if (S.chatActivo && S.chatActivo.virtual) lista.unshift(S.chatActivo);
    if (filtro) {
      lista = lista.filter(c =>
        F.sinAcentos((c.titulo || '').toLowerCase()).includes(filtro) ||
        F.sinAcentos((c.previewUltimaLinea || '').toLowerCase()).includes(filtro));
    }

    if (!lista.length) {
      cont.appendChild(el('div', 'vacio', filtro ? 'sin coincidencias' : 'sin chats · Alt+N para empezar'));
      return;
    }

    const fijados = lista.filter(c => c.fijado);
    const resto = lista.filter(c => !c.fijado);

    const pintarGrupo = (txt, clave, items) => {
      if (!items.length) return;
      const h = el('button', 'grupo');
      h.type = 'button';
      const cerrado = S.gruposCerrados.has(clave);
      h.appendChild(el('span', 'caret', cerrado ? '▸' : '▾'));
      h.appendChild(el('span', null, txt + '  (' + items.length + ')'));
      h.onclick = () => {
        if (cerrado) S.gruposCerrados.delete(clave); else S.gruposCerrados.add(clave);
        pintarLista();
      };
      cont.appendChild(h);
      if (cerrado) return;
      for (const c of items) cont.appendChild(filaChat(c));
    };

    pintarGrupo('Fijados', 'fijados', fijados);
    const orden = [];
    const mapa = new Map();
    for (const c of resto) {
      const g = grupoDe(c.actualizado);
      if (!mapa.has(g.clave)) { mapa.set(g.clave, { txt: g.txt, items: [] }); orden.push(g.clave); }
      mapa.get(g.clave).items.push(c);
    }
    for (const clave of orden) pintarGrupo(mapa.get(clave).txt, clave, mapa.get(clave).items);
  }

  function filaChat(c) {
    const b = el('button', 'chat');
    b.type = 'button';
    if (S.chatActivo && c.id === S.chatActivo.id) b.classList.add('activo');
    const l1 = el('div', 'l1');
    if (c.borrador && c.borrador.trim()) l1.appendChild(el('span', 'punto', '•'));
    const t = el('span', 'tit', c.titulo || 'Sin título');
    if (!c.tituloManual) t.classList.add('auto');
    l1.appendChild(t);
    if (c.numAbiertos) l1.appendChild(el('span', 'abierto', '▲'));
    b.appendChild(l1);
    const l2 = el('div', 'l2');
    l2.appendChild(el('span', 'prev', c.previewUltimaLinea || (c.virtual ? 'sin guardar' : '—')));
    l2.appendChild(el('span', 'cuando', c.virtual ? 'nuevo' : F.relativo(c.actualizado)));
    b.appendChild(l2);
    b.onclick = () => irChat(c.id);
    return b;
  }

  function pintarHilo() {
    const c = S.chatActivo;
    const path = $('thread-path');
    vaciar(path);
    if (!c) { path.textContent = '—'; return; }
    path.appendChild(el('span', 'ag', S.agenteActivo ? S.agenteActivo.nombre : ''));
    path.appendChild(el('span', 'sep', '›'));
    path.appendChild(el('span', 'tt', c.titulo || 'Sin título'));
    $('thread-when').textContent = c.virtual ? '' : F.relativo(c.actualizado);
    $('thread-actions').querySelector('[data-act=fijar]').textContent = c.fijado ? 'Desfijar' : 'Fijar';
    $('thread-actions').querySelector('[data-act=archivar]').textContent = c.archivado ? 'Desarchivar' : 'Archivar';

    const cont = $('thread-body');
    vaciar(cont);

    const total = S.mensajes.length;
    const desde = Math.max(0, total - S.ventana);
    $('thread-older').hidden = desde === 0;
    if (desde > 0) {
      $('thread-older').querySelector('button').textContent =
        'cargar anteriores · quedan ' + desde;
    }

    let diaAnterior = null;
    for (let i = desde; i < total; i++) {
      const m = S.mensajes[i];
      const dc = F.diaClave(m.creado);
      if (dc !== diaAnterior) {
        cont.appendChild(el('div', 'dia', F.fechaLarga(m.creado)));
        diaAnterior = dc;
      }
      cont.appendChild(m.rol === 'ensamblaje' ? nodoEnsamblaje(m) : nodoMensaje(m));
    }

    // En Memoria, el panel de alcance se muestra mientras no haya nada que
    // consultar: es el acto explícito que hace falta antes de la primera vez.
    if (esMemoria() && !alcanzables().length) cont.appendChild(panelAlcance());

    if (!total) {
      const v = el('div', 'vacio');
      v.style.paddingLeft = '72px';
      v.textContent = c.virtual
        ? 'Chat nuevo. No existe en disco hasta que escribas algo.'
        : 'Sin mensajes.';
      cont.appendChild(v);
    }

    // Línea de reanudación: solo si el chat lleva más de 72 h parado.
    const rl = $('resume-line');
    if (c && !c.virtual && total && (Date.now() - c.actualizado) > 72 * 3600000) {
      rl.textContent = 'reanudando · última actividad ' + F.fechaLarga(c.actualizado);
      rl.hidden = false;
    } else rl.hidden = true;

    pintarChips();
  }

  const ROL_MARCA = { usuario: '>', agente: '·', recibido: '⇤', sistema: '·' };

  function nodoMensaje(m) {
    const d = el('div', 'msg rol-' + m.rol + ' estado-' + m.estado);
    d.dataset.id = m.id;
    if (m.id === S.focoMsgId) d.classList.add('foco');
    if (S.marcados.has(m.id)) d.classList.add('marcado');

    const g = el('div', 'medianil');
    g.appendChild(el('div', 'hora', F.hhmm(m.creado)));
    const r = el('div', 'rol', m.estado === 'error' || m.estado === 'pendiente' ? '!' : (ROL_MARCA[m.rol] || '·'));
    g.appendChild(r);
    if (m.abierto) g.appendChild(el('div', 'abierto', '▲'));
    d.appendChild(g);

    const cuerpo = el('div', 'cuerpo');

    if (m.rol === 'recibido' && m.procedencia) {
      const p = el('div', 'proc');
      const salto = el('button', 'salto');
      salto.type = 'button';
      salto.textContent = '← ' + m.procedencia.etiqueta;
      salto.onclick = () => saltarAOrigen(m);
      p.appendChild(salto);
      const ctx = el('button', 'ctx');
      ctx.type = 'button';
      ctx.textContent = 'en contexto: ' + (m.enContexto ? 'sí' : 'no');
      ctx.onclick = async () => {
        if (bloqueado()) return;
        m.enContexto = !m.enContexto;
        await F.mensajes.guardar(m);
        pintarHilo();
      };
      p.appendChild(ctx);
      if (m.procedencia.nota) p.appendChild(el('span', 'ctx', '“' + m.procedencia.nota + '”'));
      cuerpo.appendChild(p);
    }

    cuerpo.appendChild(MD.render(m.texto, S.resaltar));

    if (m.enviadoA && m.enviadoA.length) {
      const ea = el('div', 'enviado-a');
      for (const dest of m.enviadoA) {
        const b = el('button', null, '→ ' + dest.etiqueta);
        b.type = 'button';
        b.onclick = () => saltarAPase(dest.paseId);
        ea.appendChild(b);
        ea.appendChild(document.createTextNode(' '));
      }
      cuerpo.appendChild(ea);
    }

    d.appendChild(cuerpo);
    d.onclick = (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      S.focoMsgId = m.id;
      S.zona = 'thread';
      // El foco del DOM tiene que seguir al foco visual, o Espacio y las
      // flechas irían al compositor en vez de al hilo.
      $('thread-scroll').focus({ preventScroll: true });
      pintarHilo(); pintarEstado();
    };
    return d;
  }

  function pintarChips() {
    const cont = $('context-chips');
    vaciar(cont);
    if (!S.marcados.size) return;
    const c = el('div', 'chip');
    c.appendChild(el('b', null, S.marcados.size + ' mensaje' + (S.marcados.size > 1 ? 's' : '') + ' marcado' + (S.marcados.size > 1 ? 's' : '')));
    c.appendChild(el('span', null, ' — Alt+S envía un pase · Alt+P marca como abierto'));
    const q = el('button', 'quitar', 'quitar');
    q.type = 'button';
    q.onclick = () => { S.marcados.clear(); pintarHilo(); };
    c.appendChild(q);
    cont.appendChild(c);
  }

  function pintarEstado() {
    $('st-motor').textContent = 'motor: ' + (window.FluensMotor ? window.FluensMotor.estado() : 'ausente');
    $('st-donde').textContent = (S.agenteActivo ? S.agenteActivo.nombre : '—') +
      ' › ' + (S.chatActivo ? (S.chatActivo.titulo || 'Sin título') : '—');

    const total = S.mensajes.length;
    let pos = total;
    if (S.focoMsgId) {
      const i = S.mensajes.findIndex(m => m.id === S.focoMsgId);
      if (i >= 0) pos = i + 1;
    }
    $('st-pos').textContent = total ? pos + '/' + total : '';

    const ab = S.chatActivo && S.chatActivo.numAbiertos ? 'abiertos: ' + S.chatActivo.numAbiertos : '';
    $('st-abiertos').textContent = ab;

    $('st-guardado').textContent = S.guardadoTs ? 'guardado ' + F.hhmm(S.guardadoTs) : '';

    const cp = $('st-copia');
    if (S.ultimaCopia) {
      const dias = Math.floor((Date.now() - S.ultimaCopia.ts) / 86400000);
      cp.textContent = 'copia ' + (dias === 0 ? 'hoy' : 'hace ' + dias + ' d');
      cp.classList.toggle('alerta', dias >= 7);
    } else {
      cp.textContent = 'sin copia';
      cp.classList.add('alerta');
    }

    const lk = $('st-lock');
    lk.textContent = S.soloLectura ? 'solo lectura' : '';
    lk.classList.toggle('lock-ro', S.soloLectura);
  }

  /* ================================================================ ENVIAR */

  async function enviar() {
    if (bloqueado()) return;
    const txt = $('composer').value.trim();
    if (!txt) return;
    const chat = S.chatActivo;
    if (!chat) return;

    await conError('enviar', async () => {
      const enMemoria = esMemoria();
      const r = await F.mensajes.crear(chat, {
        rol: 'usuario', texto: txt, estado: 'guardado',
        noIndexar: enMemoria       // Memoria no se indexa a sí misma
      });
      S.chatActivo = r.chat;
      S.mensajes.push(r.mensaje);
      if (enMemoria) await responderEnMemoria(S.chatActivo, txt);
      $('composer').value = '';
      S.chatActivo.borrador = '';
      await F.chats.guardar(S.chatActivo);
      S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
      ajustarCompositor();
      marcarGuardado();
      pintarLista(); pintarHilo(); pintarEstado();
      const sc = $('thread-scroll');
      sc.scrollTop = sc.scrollHeight;
      anunciar('mensajes');

      S.desdeUltimaCopia++;
      if (S.desdeUltimaCopia >= 50) copiaAutomatica('cada 50 mensajes');

      if (!enMemoria) await pedirAlMotor(r.mensaje);
    });
  }

  /** Construye la carga útil exacta y llama al motor. Sin motor: nada falso. */
  async function construirPeticion() {
    const chat = S.chatActivo;

    // La instrucción base con sus referencias @memoria: ya expandidas. Falla en
    // cerrado: una referencia que no existe no expande nada.
    const mem = agenteMemoria();
    const entradas = F.memoria.entradasDeposito(mem ? mem.instruccionBase : '');
    const exp = F.memoria.expandirReferencias(S.agenteActivo.instruccionBase || '', entradas);

    let bloques;
    if (esMemoria()) {
      // En Memoria los bloques son el último ensamblaje, sin lo que hayas
      // quitado. Los ensamblajes anteriores del hilo NO entran: si entraran,
      // el historial serían tres ensamblajes y ni un pensamiento tuyo.
      const ult = [...S.mensajes].reverse().find(m => m.rol === 'ensamblaje');
      const frags = ult && ult.ensamblaje ? ult.ensamblaje.fragmentos.filter(f => !f.excluido) : [];
      bloques = frags.map(f => {
        const ag = S.agentes.find(a => a.id === f.agenteId);
        return {
          paseId: 'rec:' + f.mensajeId,   // no es un Pase: es una recuperación
          origen: (ag ? ag.nombre : '?') + ' · «' + f.tituloChat + '» · ' + F.fechaLarga(f.creado),
          texto: f.texto
        };
      });
    } else {
      bloques = S.mensajes
        .filter(m => m.rol === 'recibido' && m.enContexto)
        .map(m => ({
          paseId: m.paseId,
          origen: m.procedencia ? m.procedencia.etiqueta : '',
          texto: m.texto
        }));
    }

    const TOPE = 40000;
    const conversacion = S.mensajes.filter(m => m.rol !== 'recibido' && m.rol !== 'ensamblaje');
    const elegidos = [];
    let usados = 0;
    for (let i = conversacion.length - 1; i >= 1; i--) {
      const t = conversacion[i].texto.length;
      if (usados + t > TOPE) break;
      usados += t;
      elegidos.unshift(conversacion[i]);
    }
    if (conversacion.length) elegidos.unshift(conversacion[0]);   // siempre el primero
    const omitidos = conversacion.length - elegidos.length;

    return {
      peticionId: F.uid(),
      agenteId: S.agenteActivo.id,
      chatId: chat.id,
      instruccionBase: exp.texto,
      bloques,
      mensajes: elegidos.map(m => ({ rol: m.rol, texto: m.texto, creado: m.creado })),
      recorte: { aplicado: omitidos > 0, mensajesOmitidos: Math.max(0, omitidos) },
      referencias: exp.referencias
    };
  }

  /** Alt+Shift+V — la cadena exacta que se enviaría. Entera, antes de enviar. */
  async function verCargaUtil() {
    const p = await construirPeticion();
    const { body } = abrirOverlay('Carga útil · ' + S.agenteActivo.nombre,
      'esto es exactamente lo que saldría de esta máquina');

    const rotas = (p.referencias || []).filter(r => !r.ok);
    if (rotas.length) {
      const av = el('div', 'ens-vacio');
      av.style.color = 'var(--alerta)';
      av.textContent = 'Referencias que NO expanden (y por tanto no envían nada): ' +
        rotas.map(r => '@memoria:' + r.clave).join(', ');
      body.appendChild(av);
    }

    const partes = [];
    partes.push(['INSTRUCCIÓN BASE (con @memoria: expandidas)', p.instruccionBase]);
    p.bloques.forEach((b, i) => partes.push(['BLOQUE ' + (i + 1) + ' — ' + b.origen, b.texto]));
    partes.push(['HILO (' + p.mensajes.length + ' mensajes' +
      (p.recorte.aplicado ? ', ' + p.recorte.mensajesOmitidos + ' omitidos por recorte' : '') + ')',
    p.mensajes.map(m => (m.rol === 'usuario' ? '> ' : '· ') + m.texto).join('\n\n')]);

    let total = 0;
    for (const [t, c] of partes) total += (c || '').length;
    body.appendChild(el('div', 'ens-l1', 'total ' + total.toLocaleString('es') + ' caracteres · ' +
      p.bloques.length + ' bloques · ' + p.mensajes.length + ' mensajes'));

    for (const [titulo, contenido] of partes) {
      const b = el('div', 'bloque');
      b.appendChild(el('h3', null, titulo));
      const pre = el('pre');
      pre.textContent = contenido || '(vacío)';
      b.appendChild(pre);
      body.appendChild(b);
    }

    const btns = el('div', 'btns');
    const bc = el('button', null, 'Copiar al portapapeles');
    bc.type = 'button';
    bc.onclick = async () => {
      const txt = partes.map(([t, c]) => '===== ' + t + ' =====\n' + (c || '')).join('\n\n');
      try { await navigator.clipboard.writeText(txt); aviso('carga útil copiada'); }
      catch (_) { aviso('no se pudo copiar', true); }
    };
    btns.appendChild(bc);
    body.appendChild(btns);
  }

  async function pedirAlMotor(mensajeUsuario) {
    const motor = window.FluensMotor;
    if (!motor || motor.estado() === 'ausente') {
      // El motor no existe todavía: esto es una bitácora, no un fallo.
      // El mensaje queda 'guardado' y sin marca de error. Solo un motor que
      // SÍ existe y falla deja mensajes en 'pendiente'.
      return;
    }
    const pet = await construirPeticion();
    const chatOrigenId = pet.chatId;
    const chatOrigen = S.chatActivo && S.chatActivo.id === chatOrigenId
      ? S.chatActivo
      : await F.chats.obtener(chatOrigenId);
    if (!chatOrigen) throw new Error('CHAT_ORIGEN_AUSENTE');
    const tl = $('trim-line');
    if (pet.recorte.aplicado) {
      tl.textContent = 'contexto recortado · ' + pet.recorte.mensajesOmitidos + ' mensajes anteriores fuera';
      tl.hidden = false;
    } else tl.hidden = true;

    let acumulado = '';
    motor.enviar(pet, {
      onToken: (t) => { acumulado += t; },
      onFin: async (final) => {
        await conError('motor-fin', async () => {
          const r = await F.mensajes.crear(chatOrigen, { rol: 'agente', texto: final || acumulado, estado: 'guardado' });
          if (S.chatActivo && S.chatActivo.id === chatOrigenId) {
            S.chatActivo = r.chat;
            S.mensajes.push(r.mensaje);
            pintarHilo(); pintarLista(); marcarGuardado();
            anunciar('mensajes');
          }
        });
      },
      onError: async (err) => {
        mensajeUsuario.estado = 'pendiente';
        await F.mensajes.guardar(mensajeUsuario);
        await F.errores.registrar('motor', err, 'chat ' + chatOrigenId);
        if (S.chatActivo && S.chatActivo.id === chatOrigenId) pintarHilo();
      }
    });
  }

  /* ═══════════════════════════════════════════════════ MEMORIA CENTRAL */

  const PLANTILLA_MEMORIA =
    '## quien · alta ' + new Date().toISOString().slice(0, 10) + '\n' +
    'Escribe aquí lo que tendrías que reexplicar en cualquier agente:\n' +
    'quién eres, cómo quieres que te respondan, vocabulario y alias,\n' +
    'unidades, husos horarios, decisiones ya cerradas.\n' +
    '\n' +
    '## unidades · alta ' + new Date().toISOString().slice(0, 10) + '\n' +
    'Ejemplo: importes en euros, fechas en formato día/mes/año.\n' +
    '\n' +
    '— Cada entrada empieza por "## clave". Desde otro agente, la línea\n' +
    '  @memoria:unidades\n' +
    '  se sustituye por el cuerpo de esa entrada al construir la petición.\n' +
    '  Una sola copia, corregible en un sitio, con rastro visible allí donde\n' +
    '  la citas. Lo que no citas, no viaja.\n' +
    '— Aquí NO va lo que pasó: eso se recupera. Ni lo de un dominio concreto:\n' +
    '  eso vive en la ficha de su agente.';

  const esMemoria = () => !!(S.agenteActivo && S.agenteActivo.esMemoria);
  const agenteMemoria = () => S.agentes.find(a => a.esMemoria) || null;
  const alcanzables = () => S.agentes.filter(a => !a.esMemoria && a.alcanzablePorMemoria);

  async function crearAgenteMemoria() {
    const m = await F.agentes.crear({
      nombre: 'Memoria', glifo: '≡', esMemoria: true, fijo: true, posicion: 999,
      instruccionBase: PLANTILLA_MEMORIA
    });
    m.posicion = 0;
    await F.agentes.guardar(m);
    S.agentes = await F.agentes.listar();
    return m;
  }

  /** Alt+M — conmutador: va a Memoria y vuelve exactamente de donde saliste. */
  async function alternarMemoria() {
    const mem = agenteMemoria();
    if (!mem) return;
    if (esMemoria()) {
      const vuelta = S.ui.vueltaDesdeMemoria;
      if (vuelta && S.agentes.some(a => a.id === vuelta.agenteId)) {
        await irAgente(vuelta.agenteId, true);
        if (vuelta.chatId) await irChat(vuelta.chatId, true);
      } else {
        const otro = S.agentes.find(a => !a.esMemoria);
        if (otro) await irAgente(otro.id);
      }
      return;
    }
    S.ui.vueltaDesdeMemoria = {
      agenteId: S.agenteActivo ? S.agenteActivo.id : null,
      chatId: S.chatActivo && !S.chatActivo.virtual ? S.chatActivo.id : null
    };
    await guardarUI();
    await irAgente(mem.id);
  }

  /** Construye el ensamblaje y lo cuelga como mensaje bajo la consulta. */
  async function responderEnMemoria(chat, consulta) {
    const alc = alcanzables();
    const exclusiones = chat.exclusionesMemoria || { agentes: [], mensajes: [] };

    const paquete = await F.memoria.ensamblar(consulta, {
      alcanzables: alc.map(a => a.id),
      excluirAgentes: exclusiones.agentes,
      excluirMensajes: exclusiones.mensajes,
      totalAgentes: S.agentes.filter(a => !a.esMemoria).length
    });

    const r = paquete.resumen;
    const resumenTexto = paquete.fragmentos.length
      ? paquete.fragmentos.length + ' fragmentos · ' +
      new Set(paquete.fragmentos.map(f => f.agenteId)).size + ' agentes · ' +
      r.coincidentes + ' coincidentes de ' + r.mensajesConsultados + ' consultados'
      : 'sin coincidencias';

    const res = await F.mensajes.crear(chat, {
      rol: 'ensamblaje', texto: resumenTexto, ensamblaje: paquete, noIndexar: true
    });
    S.chatActivo = res.chat;
    S.mensajes.push(res.mensaje);
    return res.mensaje;
  }

  function nodoEnsamblaje(m) {
    const e = m.ensamblaje || { fragmentos: [], terminos: [], resumen: {} };
    const r = e.resumen || {};
    const d = el('div', 'msg rol-ensamblaje');
    d.dataset.id = m.id;

    const g = el('div', 'medianil');
    g.appendChild(el('span', 'hora', F.hhmm(m.creado)));
    g.appendChild(el('span', 'rol', '≡'));
    d.appendChild(g);

    const cuerpo = el('div', 'cuerpo ensamblaje');

    // Cabecera: la aritmética a la vista. "Contexto de todos los chats" no
    // significa que entre todo; significa esto, y se dice con números.
    const cab = el('div', 'ens-cab');
    const nAg = new Set(e.fragmentos.map(f => f.agenteId)).size;
    cab.appendChild(el('div', 'ens-l1',
      e.fragmentos.length + ' fragmento' + (e.fragmentos.length === 1 ? '' : 's') +
      ' · ' + nAg + ' agente' + (nAg === 1 ? '' : 's') +
      ' · ' + (r.coincidentes || 0) + ' coincidentes de ' + (r.mensajesConsultados || 0) + ' consultados'));

    const l2 = [];
    l2.push((r.caracteresUsados || 0) + '/' + F.memoria.MEM.MAX_CARACTERES + ' car.');
    if (r.caracteresVecindad) l2.push(r.caracteresVecindad + ' de vecindad');
    if (r.agentesNoAlcanzables) l2.push(r.agentesNoAlcanzables + ' agente' + (r.agentesNoAlcanzables === 1 ? '' : 's') + ' no alcanzable' + (r.agentesNoAlcanzables === 1 ? '' : 's') + ' (no consultados)');
    if (e.modo === 'literal') l2.push('corpus pequeño: coincidencia literal, sin ponderación');
    if (r.consultaAcotada) l2.push('consulta acotada: términos muy frecuentes recortados');
    cab.appendChild(el('div', 'ens-l2', l2.join(' · ')));

    if (e.terminos && e.terminos.length) {
      const usados = e.terminos.filter(t => t.estado === 'usado');
      const sin = e.terminos.filter(t => t.estado !== 'usado');
      const t1 = el('div', 'ens-term');
      t1.appendChild(el('span', 'et', 'términos: '));
      t1.appendChild(document.createTextNode(usados.map(t => t.token + ' ' + t.peso.toFixed(2)).join(' · ') || '—'));
      cab.appendChild(t1);
      if (sin.length) {
        cab.appendChild(el('div', 'ens-term',
          'sin apariciones: ' + sin.map(t => t.token).join(', ')));
      }
    }
    cuerpo.appendChild(cab);

    if (!e.fragmentos.length) {
      const v = el('div', 'ens-vacio');
      if (!alcanzables().length) {
        v.textContent = 'Ningún agente es alcanzable por la memoria todavía. Elige cuáles puede consultar más abajo.';
      } else {
        const sinAp = (e.terminos || []).filter(t => t.estado !== 'usado').map(t => t.token);
        v.textContent = sinAp.length
          ? 'Sin coincidencias. Estos términos no aparecen en ninguna parte del corpus alcanzable: ' + sinAp.join(', ') + '.'
          : 'Sin coincidencias: los términos existen, pero no juntos en ningún mensaje.';
      }
      cuerpo.appendChild(v);
      d.appendChild(cuerpo);
      return d;
    }

    const lista = el('div', 'ens-frags');
    const abierto = S.ensamblajesAbiertos.has(m.id);
    const visibles = abierto ? e.fragmentos : e.fragmentos.slice(0, 3);

    for (const f of visibles) {
      const ag = S.agentes.find(a => a.id === f.agenteId);
      const fr = el('div', 'frag' + (f.excluido ? ' excluido' : ''));

      const fc = el('div', 'frag-cab');
      fc.appendChild(el('span', 'frag-org',
        (ag ? ag.nombre : '(agente borrado)') + ' · «' + f.tituloChat + '» · ' + F.fechaLarga(f.creado)));
      fc.appendChild(el('span', 'frag-punt', f.puntuacion.toFixed(2)));
      fr.appendChild(fc);

      for (const v of (f.vecinos || [])) {
        if (v.mensajeId && f.vecinos.indexOf(v) === 0) {
          fr.appendChild(el('div', 'frag-vecino', v.texto));
        }
      }
      fr.appendChild(MD.render(f.texto, f.terminos));
      if ((f.vecinos || []).length > 1) {
        fr.appendChild(el('div', 'frag-vecino', f.vecinos[1].texto));
      }
      if (f.recortado) fr.appendChild(el('div', 'frag-nota', 'fragmento recortado'));

      const acc = el('div', 'frag-acc');
      const bSalto = el('button', null, '→ ir al original');
      bSalto.type = 'button';
      bSalto.onclick = async () => { apilarSalto(); await irChat(f.chatId); destacar(f.mensajeId); };
      acc.appendChild(bSalto);
      acc.appendChild(el('i', null, '·'));
      const bEx = el('button', null, f.excluido ? 'incluir' : 'quitar');
      bEx.type = 'button';
      bEx.onclick = async () => {
        f.excluido = !f.excluido;
        await F.mensajes.guardar(m);
        pintarHilo();
      };
      acc.appendChild(bEx);
      acc.appendChild(el('i', null, '·'));
      const bAg = el('button', null, 'no consultar ' + (ag ? ag.nombre : 'este agente') + ' en este chat');
      bAg.type = 'button';
      bAg.onclick = () => excluirAgenteEnChat(f.agenteId);
      acc.appendChild(bAg);
      fr.appendChild(acc);

      lista.appendChild(fr);
    }
    cuerpo.appendChild(lista);

    const pie = el('div', 'ens-pie');
    if (e.fragmentos.length > 3) {
      const b = el('button', null, abierto
        ? 'plegar' : 'ver los ' + e.fragmentos.length + ' fragmentos');
      b.type = 'button';
      b.onclick = () => {
        if (abierto) S.ensamblajesAbiertos.delete(m.id); else S.ensamblajesAbiertos.add(m.id);
        pintarHilo();
      };
      pie.appendChild(b);
      pie.appendChild(el('i', null, ' · '));
    }
    const restantes = (r.coincidentes || 0) - e.fragmentos.length;
    if (restantes > 0) {
      pie.appendChild(el('span', null, 'otros ' + restantes + ' coincidentes — Alt+K'));
      pie.appendChild(el('i', null, ' · '));
    }
    const rehacer = el('button', null, 'reensamblar con el corpus de hoy');
    rehacer.type = 'button';
    rehacer.onclick = () => reensamblar(e.consulta);
    pie.appendChild(rehacer);
    cuerpo.appendChild(pie);

    d.appendChild(cuerpo);
    return d;
  }

  async function excluirAgenteEnChat(agenteId) {
    if (bloqueado() || !S.chatActivo) return;
    const c = S.chatActivo;
    c.exclusionesMemoria = c.exclusionesMemoria || { agentes: [], mensajes: [] };
    if (!c.exclusionesMemoria.agentes.includes(agenteId)) c.exclusionesMemoria.agentes.push(agenteId);
    await F.chats.guardar(c);
    const ag = S.agentes.find(a => a.id === agenteId);
    aviso((ag ? ag.nombre : 'agente') + ' excluido de este chat de memoria — permanente');
  }

  async function reensamblar(consulta) {
    if (bloqueado() || !esMemoria() || !consulta) return;
    await conError('reensamblar', async () => {
      await responderEnMemoria(S.chatActivo, consulta);
      S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
      pintarLista(); pintarHilo(); marcarGuardado();
      const sc = $('thread-scroll'); sc.scrollTop = sc.scrollHeight;
    });
  }

  /** Panel de alcance: el acto explícito que decide qué puede consultar. */
  function panelAlcance() {
    const caja = el('div', 'alcance');
    caja.appendChild(el('h3', null, 'Qué puede consultar la memoria'));
    caja.appendChild(el('p', null,
      'Los agentes nacen fuera del alcance. Marcar uno es una decisión tuya, y solo afecta a lo que la memoria puede leer: nada se copia ni se mueve.'));
    for (const a of S.agentes) {
      if (a.esMemoria) continue;
      const fila = el('label', 'alcance-fila');
      const chk = el('input');
      chk.type = 'checkbox';
      chk.checked = !!a.alcanzablePorMemoria;
      chk.onchange = async () => {
        if (bloqueado()) { chk.checked = !chk.checked; return; }
        a.alcanzablePorMemoria = chk.checked;
        await F.agentes.guardar(a);
        S.agentes = await F.agentes.listar();
        anunciar('agentes');
        pintarHilo();
        aviso(a.nombre + (chk.checked ? ' es alcanzable por la memoria' : ' ya no es alcanzable'));
      };
      fila.appendChild(chk);
      fila.appendChild(el('span', null, a.nombre));
      caja.appendChild(fila);
    }
    return caja;
  }

  /* ================================================================== PASE */

  function textoSeleccionado() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const txt = sel.toString().trim();
    if (!txt) return null;
    let nodo = sel.anchorNode;
    while (nodo && !(nodo.classList && nodo.classList.contains('msg'))) nodo = nodo.parentNode;
    return nodo ? { texto: txt, mensajeId: nodo.dataset.id } : null;
  }

  async function abrirPase(esperaRespuesta) {
    if (bloqueado()) return;
    const sel = textoSeleccionado();
    let ids = [];
    let snapshot = '';
    let fragmento = null;

    if (sel) {
      ids = [sel.mensajeId];
      snapshot = sel.texto;
      fragmento = { mensajeId: sel.mensajeId };
    } else if (S.marcados.size) {
      // Un ensamblaje NO viaja. Para llevar algo a otro agente se salta al
      // original y se pasa desde allí: así ves el texto exacto que mueves y el
      // Pase sale del agente dueño, con su trazabilidad.
      const elegidos = S.mensajes.filter(m => S.marcados.has(m.id) && m.rol !== 'ensamblaje');
      if (!elegidos.length) { aviso('un ensamblaje no se puede pasar — salta al original con "→ ir al original"', true); return; }
      ids = elegidos.map(m => m.id);
      snapshot = elegidos.map(m => m.texto).join('\n\n');
    } else if (S.focoMsgId) {
      const m = S.mensajes.find(x => x.id === S.focoMsgId);
      if (m && m.rol === 'ensamblaje') { aviso('un ensamblaje no se puede pasar — salta al original', true); return; }
      ids = [S.focoMsgId];
      snapshot = m ? m.texto : '';
    } else {
      aviso('marca mensajes con Espacio o selecciona texto, y vuelve a pulsar Alt+S');
      return;
    }

    dialogoPase({ ids, snapshot, fragmento, esperaRespuesta });
  }

  function dialogoPase(base) {
    const seleccion = new Set();
    let idx = 0;
    let destinoChat = new Map();   // agenteId -> chatId | null (null = bandeja)

    const box = abrirOverlay('Pase' + (base.esperaRespuesta ? ' · espera respuesta' : ''),
      'Espacio marca varios destinos · Tab a la nota · Enter envía · Esc cancela');

    const body = box.body;

    const cInput = el('div', 'campo');
    cInput.appendChild(el('label', null, 'Agente destino'));
    const inp = el('input', 'ov-input');
    inp.type = 'text';
    inp.placeholder = 'escribe dos o tres letras…';
    cInput.appendChild(inp);
    body.appendChild(cInput);

    const lista = el('div', 'destino-lista');
    body.appendChild(lista);

    const cNota = el('div', 'campo');
    cNota.style.marginTop = '12px';
    cNota.appendChild(el('label', null, 'Nota (opcional, una línea)'));
    const nota = el('input');
    nota.type = 'text';
    cNota.appendChild(nota);
    body.appendChild(cNota);

    const prev = el('div', 'bloque');
    prev.style.marginTop = '12px';
    prev.appendChild(el('h3', null, 'Se envía'));
    const pv = el('div', 'ficha');
    pv.appendChild(el('div', 'frag', base.snapshot.slice(0, 400)));
    prev.appendChild(pv);
    body.appendChild(prev);

    const candidatos = () => {
      const q = F.sinAcentos(inp.value.toLowerCase().trim());
      return S.agentes.filter(a =>
        a.id !== (S.agenteActivo && S.agenteActivo.id) &&
        (!q || F.sinAcentos(a.nombre.toLowerCase()).includes(q)));
    };

    function pintar() {
      vaciar(lista);
      const cs = candidatos();
      if (idx >= cs.length) idx = Math.max(0, cs.length - 1);
      cs.forEach((a, i) => {
        const b = el('button', 'destino');
        b.type = 'button';
        if (i === idx) b.classList.add('sel');
        b.appendChild(el('span', 'marca', seleccion.has(a.id) ? '✓' : ''));
        b.appendChild(el('span', null, a.nombre));
        const dc = destinoChat.has(a.id) ? destinoChat.get(a.id) : undefined;
        const ultimo = S.ui.ultimoChatPorAgente[a.id];
        const etiqueta = dc === null ? 'bandeja'
          : dc === 'nuevo' ? 'chat nuevo'
            : (ultimo ? 'último chat' : 'bandeja');
        b.appendChild(el('span', 'sub', etiqueta + '  ·  Tab cambia'));
        b.onclick = () => { idx = i; alternar(a.id); pintar(); };
        lista.appendChild(b);
      });
      if (!cs.length) lista.appendChild(el('div', 'vacio', 'ningún otro agente'));
    }

    function alternar(id) {
      if (seleccion.has(id)) { seleccion.delete(id); destinoChat.delete(id); }
      else {
        seleccion.add(id);
        // Por defecto: el último chat abierto de ese agente, NO la bandeja.
        destinoChat.set(id, S.ui.ultimoChatPorAgente[id] || null);
      }
    }

    function rotarDestino() {
      const cs = candidatos();
      const a = cs[idx];
      if (!a) return;
      if (!seleccion.has(a.id)) alternar(a.id);
      const ultimo = S.ui.ultimoChatPorAgente[a.id];
      const actual = destinoChat.get(a.id);
      let siguiente;
      if (actual === ultimo && ultimo) siguiente = 'nuevo';
      else if (actual === 'nuevo') siguiente = null;
      else siguiente = ultimo || 'nuevo';
      destinoChat.set(a.id, siguiente);
      pintar();
    }

    inp.oninput = () => { idx = 0; pintar(); };
    inp.onkeydown = (e) => {
      const cs = candidatos();
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(cs.length - 1, idx + 1); pintar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); pintar(); }
      else if (e.key === ' ' && !inp.value) { e.preventDefault(); if (cs[idx]) { alternar(cs[idx].id); pintar(); } }
      else if (e.key === 'Tab' && !e.shiftKey && cs.length) { e.preventDefault(); rotarDestino(); }
      else if (e.key === 'Enter') { e.preventDefault(); confirmar(); }
    };
    nota.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmar(); } };

    async function confirmar() {
      if (!seleccion.size) {
        const cs = candidatos();
        if (cs[idx]) alternar(cs[idx].id);
      }
      if (!seleccion.size) { aviso('elige al menos un agente destino'); return; }
      cerrarOverlay();
      await ejecutarPase(base, [...seleccion].map(id => ({
        agenteId: id,
        chatId: (() => {
          const d = destinoChat.get(id);
          if (d === null || d === undefined) return null;
          if (d === 'nuevo') return 'nuevo';
          return d;
        })()
      })), nota.value.trim());
    }

    pintar();
    setTimeout(() => inp.focus(), 0);
  }

  async function ejecutarPase(base, destinos, nota) {
    await conError('pase', async () => {
      const origenChat = S.chatActivo;
      const resueltos = [];

      for (const d of destinos) {
        let chatId = d.chatId;
        if (chatId === 'nuevo') {
          const c = F.chats.nuevoVirtual(d.agenteId);
          c.virtual = false;
          c.titulo = 'Pase de ' + S.agenteActivo.nombre + ' · ' + F.fechaCorta(Date.now());
          c.tituloManual = true;
          await F.chats.guardar(c);
          chatId = c.id;
        }
        resueltos.push({ agenteId: d.agenteId, chatId });
      }

      const creados = await F.pases.crear({
        origenAgenteId: S.agenteActivo.id,
        origenChatId: origenChat.id,
        origenMensajeIds: base.ids,
        fragmento: base.fragmento,
        textoSnapshot: base.snapshot,
        nota: nota || '',
        esperaRespuesta: !!base.esperaRespuesta,
        origenTipo: 'usuario'
      }, resueltos);

      const etiquetaOrigen = S.agenteActivo.nombre + ' · «' +
        (origenChat.titulo || 'sin título') + '» · ' + F.fechaCorta(Date.now());

      // Los que van a un chat concreto se insertan ya como bloque recibido.
      for (const p of creados) {
        if (!p.destinoChatId) continue;
        const chatDestino = await F.chats.obtener(p.destinoChatId);
        if (!chatDestino) continue;
        const r = await F.mensajes.crear(chatDestino, {
          rol: 'recibido',
          texto: p.textoSnapshot,
          paseId: p.id,
          enContexto: true,
          procedencia: {
            etiqueta: etiquetaOrigen,
            nota: p.nota,
            agenteId: p.origenAgenteId,
            chatId: p.origenChatId,
            mensajeId: base.ids[0] || null
          }
        });
        p.destinoMensajeId = r.mensaje.id;
        p.procesado = Date.now();
        await F.pases.guardar(p);
      }

      // Marca de salida en el origen.
      for (const id of base.ids) {
        const m = await F.mensajes.obtener(id);
        if (!m) continue;
        m.enviadoA = m.enviadoA || [];
        for (const p of creados) {
          const ag = S.agentes.find(a => a.id === p.destinoAgenteId);
          m.enviadoA.push({ paseId: p.id, etiqueta: ag ? ag.nombre : 'agente' });
        }
        await F.mensajes.guardar(m);
      }

      S.marcados.clear();
      S.bandejas = await F.pases.contarBandejas();
      S.mensajes = await F.mensajes.listar(S.chatActivo.id);
      pintarRail(); pintarHilo(); pintarLista(); marcarGuardado();
      anunciar('pases');

      const nombres = creados.map(p => {
        const a = S.agentes.find(x => x.id === p.destinoAgenteId);
        return a ? a.nombre : '?';
      }).join(', ');

      ofrecerDeshacer('pase enviado a ' + nombres, async () => {
        for (const p of creados) await F.pases.revocar(p.id);
        for (const id of base.ids) {
          const m = await F.mensajes.obtener(id);
          if (!m || !m.enviadoA) continue;
          const quitar = new Set(creados.map(p => p.id));
          m.enviadoA = m.enviadoA.filter(x => !quitar.has(x.paseId));
          await F.mensajes.guardar(m);
        }
        S.bandejas = await F.pases.contarBandejas();
        S.mensajes = await F.mensajes.listar(S.chatActivo.id);
        pintarRail(); pintarHilo();
        anunciar('pases');
      });
    });
  }

  async function saltarAOrigen(m) {
    if (!m.procedencia || !m.procedencia.chatId) return;
    apilarSalto();
    await irChat(m.procedencia.chatId);
    if (m.procedencia.mensajeId) destacar(m.procedencia.mensajeId);
  }

  async function saltarAPase(paseId) {
    const p = await F.pases.obtener(paseId);
    if (!p) return;
    if (p.estado === 'revocado') { aviso('ese pase fue revocado'); return; }
    apilarSalto();
    if (p.destinoChatId) {
      await irChat(p.destinoChatId);
      if (p.destinoMensajeId) destacar(p.destinoMensajeId);
    } else {
      await irAgente(p.destinoAgenteId);
      overlayBandeja();
    }
  }

  function apilarSalto() {
    if (!S.chatActivo) return;
    S.ui.pilaSaltos = S.ui.pilaSaltos || [];
    S.ui.pilaSaltos.push({ chatId: S.chatActivo.id, msgId: S.focoMsgId });
    if (S.ui.pilaSaltos.length > 50) S.ui.pilaSaltos.shift();
  }

  async function volverSalto() {
    const p = (S.ui.pilaSaltos || []).pop();
    if (!p) { aviso('no hay saltos que deshacer'); return; }
    await irChat(p.chatId);
    if (p.msgId) destacar(p.msgId);
    await guardarUI();
  }

  function destacar(mensajeId) {
    const i = S.mensajes.findIndex(m => m.id === mensajeId);
    if (i >= 0) {
      const desdeElFinal = S.mensajes.length - i;
      if (desdeElFinal > S.ventana) { S.ventana = desdeElFinal + 20; pintarHilo(); }
    }
    S.focoMsgId = mensajeId;
    pintarHilo(); pintarEstado();
    setTimeout(() => {
      const n = document.querySelector('.msg[data-id="' + mensajeId + '"]');
      if (!n) return;
      n.scrollIntoView({ block: 'center' });
      n.classList.add('destello');
      setTimeout(() => n.classList.remove('destello'), 2000);
    }, 30);
  }

  /* ========================================================= SUPERPOSICIONES */

  let overlayAbierto = null;

  function abrirOverlay(titulo, pista) {
    const cont = $('overlay');
    const box = $('overlay-box');
    vaciar(box);
    const head = el('div', 'ov-head');
    head.appendChild(el('h2', null, titulo));
    if (pista) head.appendChild(el('span', 'pista', pista));
    box.appendChild(head);
    const body = el('div', 'ov-body');
    box.appendChild(body);
    cont.hidden = false;
    overlayAbierto = titulo;
    return { box, body, head };
  }

  function cerrarOverlay() {
    $('overlay').hidden = true;
    overlayAbierto = null;
    vaciar($('overlay-box'));
    $('composer').focus();
  }

  /* ------------------------------------------------------------- PALETA */

  async function overlayPaleta() {
    const { box, body } = abrirOverlay('Buscar', 'agente: · desde: · hasta: · "frase exacta" · ↑↓ mueve · Enter abre · Esc vuelve');
    body.classList.add('sin-pad');
    box.querySelector('.ov-body').remove();

    const cabInput = el('div');
    cabInput.style.padding = '10px 14px';
    cabInput.style.borderBottom = '1px solid var(--line)';
    const inp = el('input', 'ov-input');
    inp.type = 'text';
    inp.placeholder = 'buscar en todos los agentes…';
    cabInput.appendChild(inp);
    const fichas = el('div');
    fichas.style.marginTop = '6px';
    fichas.style.font = '11px var(--mono)';
    fichas.style.color = 'var(--fg-mute)';
    cabInput.appendChild(fichas);
    box.appendChild(cabInput);

    const split = el('div', 'split');
    const izq = el('div', 'izq');
    const der = el('div', 'der');
    split.appendChild(izq); split.appendChild(der);
    box.appendChild(split);

    const pie = el('div', 'ov-foot');
    box.appendChild(pie);

    let items = [];
    let sel = 0;
    let modo = 'recientes';

    async function recientes() {
      modo = 'recientes';
      const cs = await F.chats.recientes(8);
      items = cs.map(c => ({ tipo: 'chat', chat: c }));
      sel = 0;
      pintarRes();
      pie.textContent = 'chats tocados más recientemente · escribe para buscar en el contenido';
    }

    async function buscar() {
      const q = inp.value.trim();
      if (!q) return recientes();
      modo = 'busqueda';
      const r = await F.buscar(q, S.agentes, 200);
      fichas.textContent = r.consulta.fichas.join('   ');
      items = r.items.map(m => ({ tipo: 'msg', msg: m }));
      S.resaltar = r.terminos.concat(r.consulta.frases);
      sel = 0;
      pintarRes();
      pie.textContent = items.length
        ? items.length + ' resultado' + (items.length > 1 ? 's' : '') + (r.truncado ? ' · lista recortada, afina con agente: o desde:' : '')
        : 'sin resultados';
    }

    function pintarRes() {
      vaciar(izq);
      if (!items.length) { izq.appendChild(el('div', 'vacio', 'nada que mostrar')); vaciar(der); return; }
      items.forEach((it, i) => {
        const b = el('button', 'res');
        b.type = 'button';
        if (i === sel) b.classList.add('sel');
        if (it.tipo === 'chat') {
          const a = S.agentes.find(x => x.id === it.chat.agenteId);
          b.appendChild(el('div', 'meta', (a ? a.nombre : '?') + ' · ' + F.relativo(it.chat.actualizado)));
          b.appendChild(el('div', 'linea', it.chat.titulo || 'Sin título'));
        } else {
          const a = S.agentes.find(x => x.id === it.msg.agenteId);
          b.appendChild(el('div', 'meta', (a ? a.nombre : '?') + ' · ' + F.fechaLarga(it.msg.creado) + ' ' + F.hhmm(it.msg.creado)));
          const linea = el('div', 'linea');
          MD.texto(linea, String(it.msg.texto).replace(/\s+/g, ' ').slice(0, 180), S.resaltar);
          b.appendChild(linea);
        }
        b.onclick = () => { sel = i; abrirSel(); };
        b.onmouseenter = () => { sel = i; pintarRes(); };
        izq.appendChild(b);
      });
      pintarPrev();
    }

    async function pintarPrev() {
      vaciar(der);
      const it = items[sel];
      if (!it) return;
      if (it.tipo === 'chat') {
        const ms = await F.mensajes.listar(it.chat.id);
        der.appendChild(el('div', 'prev-msg', (it.chat.numMensajes || ms.length) + ' mensajes'));
        for (const m of ms.slice(-4)) {
          const d = el('div', 'prev-msg');
          d.appendChild(el('div', 'm', F.hhmm(m.creado) + ' ' + (ROL_MARCA[m.rol] || '·')));
          d.appendChild(MD.render(m.texto.slice(0, 400)));
          der.appendChild(d);
        }
        return;
      }
      // Tres mensajes antes y tres después, para triar sin saltar.
      const ms = await F.mensajes.listar(it.msg.chatId);
      const i = ms.findIndex(m => m.id === it.msg.id);
      const chat = await F.chats.obtener(it.msg.chatId);
      der.appendChild(el('div', 'prev-msg', '« ' + (chat ? chat.titulo : '?') + ' »'));
      for (let k = Math.max(0, i - 3); k <= Math.min(ms.length - 1, i + 3); k++) {
        const m = ms[k];
        const d = el('div', 'prev-msg' + (k === i ? ' eje' : ''));
        d.appendChild(el('div', 'm', F.hhmm(m.creado) + ' ' + (ROL_MARCA[m.rol] || '·')));
        d.appendChild(MD.render(m.texto.slice(0, 800), k === i ? S.resaltar : null));
        der.appendChild(d);
      }
    }

    async function abrirSel() {
      const it = items[sel];
      if (!it) return;
      apilarSalto();
      cerrarOverlay();
      if (it.tipo === 'chat') await irChat(it.chat.id);
      else { await irChat(it.msg.chatId); destacar(it.msg.id); }
      await guardarUI();
    }

    let t = null;
    inp.oninput = () => { clearTimeout(t); t = setTimeout(buscar, 130); };
    inp.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); pintarRes(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); pintarRes(); }
      else if (e.key === 'Enter') { e.preventDefault(); abrirSel(); }
    };

    await recientes();
    setTimeout(() => inp.focus(), 0);
  }

  /* ------------------------------------------------------------ BANDEJA */

  async function overlayBandeja() {
    const a = S.agenteActivo;
    if (!a) return;
    const { box, body } = abrirOverlay('Bandeja · ' + a.nombre,
      'Enter inserta · N chat nuevo · F fija en la ficha · Supr descarta · Esc vuelve');
    body.classList.add('sin-pad');

    let lista = await F.pases.bandeja(a.id);
    lista.sort((x, y) => x.creado - y.creado);   // más viejo primero
    let sel = 0;

    function pintar() {
      vaciar(body);
      if (!lista.length) {
        body.appendChild(el('div', 'vacio', 'bandeja vacía'));
        return;
      }
      lista.forEach((p, i) => {
        const b = el('button', 'ficha');
        b.type = 'button';
        if (i === sel) b.classList.add('sel');
        const org = S.agentes.find(x => x.id === p.origenAgenteId);
        const cab = el('div', 'cab');
        cab.appendChild(el('span', null, '← ' + (org ? org.nombre : 'agente borrado')));
        cab.appendChild(el('span', null, F.fechaLarga(p.creado)));
        const dias = Math.floor((Date.now() - p.creado) / 86400000);
        if (dias >= 1) cab.appendChild(el('span', null, dias + ' d'));
        if (p.esperaRespuesta) cab.appendChild(el('span', 'espera', '?'));
        b.appendChild(cab);
        if (p.nota) b.appendChild(el('div', 'nota', '“' + p.nota + '”'));
        b.appendChild(el('div', 'frag', String(p.textoSnapshot).replace(/\s+/g, ' ').slice(0, 200)));
        b.onclick = () => { sel = i; pintar(); };
        b.ondblclick = () => insertar();
        body.appendChild(b);
      });
    }

    async function refrescar() {
      lista = await F.pases.bandeja(a.id);
      lista.sort((x, y) => x.creado - y.creado);
      if (sel >= lista.length) sel = Math.max(0, lista.length - 1);
      S.bandejas = await F.pases.contarBandejas();
      pintarRail(); pintarLista();
      anunciar('pases');
      pintar();
    }

    async function insertarEn(chat) {
      const p = lista[sel];
      if (!p) return;
      const org = S.agentes.find(x => x.id === p.origenAgenteId);
      const chatOrigen = await F.chats.obtener(p.origenChatId);
      const r = await F.mensajes.crear(chat, {
        rol: 'recibido',
        texto: p.textoSnapshot,
        paseId: p.id,
        enContexto: true,
        procedencia: {
          etiqueta: (org ? org.nombre : 'agente') + ' · «' + (chatOrigen ? chatOrigen.titulo : '?') + '» · ' + F.fechaCorta(p.creado),
          nota: p.nota,
          agenteId: p.origenAgenteId,
          chatId: p.origenChatId,
          mensajeId: (p.origenMensajeIds || [])[0] || null
        }
      });
      p.estado = 'insertado';
      p.destinoChatId = chat.id;
      p.destinoMensajeId = r.mensaje.id;
      p.procesado = Date.now();
      await F.pases.guardar(p);
      return r;
    }

    async function insertar() {
      if (bloqueado()) return;
      const p = lista[sel];
      if (!p) return;
      let chat = S.chatActivo;
      if (!chat || chat.agenteId !== a.id || chat.virtual) {
        chat = S.chats[0];
        if (!chat) { await nuevoChatSembrado(); return; }
      }
      await insertarEn(chat);
      cerrarOverlay();
      await irChat(chat.id);
      await refrescarChatActual();
      aviso('bloque insertado');
    }

    async function nuevoChatSembrado() {
      if (bloqueado()) return;
      const p = lista[sel];
      if (!p) return;
      const c = F.chats.nuevoVirtual(a.id);
      c.virtual = false;
      const org = S.agentes.find(x => x.id === p.origenAgenteId);
      c.titulo = 'De ' + (org ? org.nombre : 'otro agente') + ' · ' + F.fechaCorta(p.creado);
      c.tituloManual = true;
      await F.chats.guardar(c);
      await insertarEn(c);
      cerrarOverlay();
      S.chats = await F.chats.listarPorAgente(a.id);
      S.bandejas = await F.pases.contarBandejas();
      await irChat(c.id);
      pintarRail();
      anunciar('pases');
      aviso('chat nuevo sembrado con el bloque');
    }

    async function fijarEnFicha() {
      if (bloqueado()) return;
      const p = lista[sel];
      if (!p) return;
      const org = S.agentes.find(x => x.id === p.origenAgenteId);
      const linea = '\n\n— de ' + (org ? org.nombre : 'otro agente') + ' · ' + F.fechaLarga(p.creado) + ' —\n';
      a.instruccionBase = (a.instruccionBase || '') + linea + p.textoSnapshot;
      await F.agentes.guardar(a);
      p.estado = 'insertado';
      p.procesado = Date.now();
      await F.pases.guardar(p);
      await refrescar();
      aviso('fijado en la instrucción base de ' + a.nombre);
    }

    async function descartar() {
      if (bloqueado()) return;
      const p = lista[sel];
      if (!p) return;
      p.estado = 'descartado';
      p.procesado = Date.now();
      await F.pases.guardar(p);
      await refrescar();
      ofrecerDeshacer('pase descartado', async () => {
        p.estado = 'bandeja';
        p.procesado = null;
        await F.pases.guardar(p);
        await refrescar();
      });
    }

    box.dataset.teclas = '1';
    box.onkeydown = null;
    document.addEventListener('keydown', teclasBandeja, true);
    function teclasBandeja(e) {
      if (overlayAbierto !== 'Bandeja · ' + a.nombre) {
        document.removeEventListener('keydown', teclasBandeja, true);
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(lista.length - 1, sel + 1); pintar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); pintar(); }
      else if (e.key === 'Enter') { e.preventDefault(); insertar(); }
      else if (e.code === 'KeyN') { e.preventDefault(); nuevoChatSembrado(); }
      else if (e.code === 'KeyF') { e.preventDefault(); fijarEnFicha(); }
      else if (e.key === 'Delete') { e.preventDefault(); descartar(); }
    }

    pintar();
    box.focus();
  }

  async function refrescarChatActual() {
    if (!S.chatActivo || S.chatActivo.virtual) return;
    S.chatActivo = await F.chats.obtener(S.chatActivo.id) || S.chatActivo;
    S.mensajes = await F.mensajes.listar(S.chatActivo.id);
    S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
    S.bandejas = await F.pases.contarBandejas();
    pintarRail(); pintarLista(); pintarHilo(); pintarEstado();
  }

  /* --------------------------------------------------------- CONEXIONES */

  async function overlayConexiones() {
    const { body } = abrirOverlay('Conexiones', 'Enter salta al destino · Shift+Enter al origen · R revoca');
    const todos = await F.pases.listar();
    const nom = (id) => { const a = S.agentes.find(x => x.id === id); return a ? a.nombre : '(borrado)'; };

    // Parte 1 — Flujo
    const pares = new Map();
    for (const p of todos) {
      if (p.estado === 'revocado') continue;
      const k = p.origenAgenteId + '>' + p.destinoAgenteId;
      const e = pares.get(k) || { o: p.origenAgenteId, d: p.destinoAgenteId, n: 0, bandeja: 0, viejo: Infinity };
      e.n++;
      if (p.estado === 'bandeja') { e.bandeja++; e.viejo = Math.min(e.viejo, p.creado); }
      pares.set(k, e);
    }
    const flujo = el('div', 'flujo');
    const orden = [...pares.values()].sort((a, b) => b.n - a.n);
    if (!orden.length) flujo.appendChild(el('div', 'nota', 'todavía no ha viajado nada entre agentes'));
    for (const e of orden.slice(0, 12)) {
      const l = el('div', 'par');
      l.appendChild(el('span', null, nom(e.o).padEnd(18, ' ') + ' → ' + nom(e.d).padEnd(18, ' ') + '  '));
      l.appendChild(el('span', 'n', String(e.n)));
      if (e.bandeja) {
        const dias = Math.floor((Date.now() - e.viejo) / 86400000);
        l.appendChild(el('span', 'nota', '   (' + e.bandeja + ' en bandeja' + (dias >= 1 ? ', ' + dias + ' d el más viejo' : '') + ')'));
      }
      flujo.appendChild(l);
    }
    const emisores = new Set(todos.filter(p => p.estado !== 'revocado').map(p => p.origenAgenteId));
    const receptores = new Set(todos.filter(p => p.estado !== 'revocado').map(p => p.destinoAgenteId));
    const aislados = S.agentes.filter(a => !emisores.has(a.id) && !receptores.has(a.id)).map(a => a.nombre);
    const mudos = S.agentes.filter(a => !emisores.has(a.id) && receptores.has(a.id)).map(a => a.nombre);
    if (aislados.length) flujo.appendChild(el('span', 'aparte', 'Aislados: ' + aislados.join(', ')));
    if (mudos.length) flujo.appendChild(el('span', 'aparte', 'Nunca han aportado: ' + mudos.join(', ')));
    body.appendChild(flujo);

    // Parte 2 — Tabla de pases
    const filtros = el('div', 'fila');
    filtros.style.marginBottom = '10px';
    const selPar = el('select');
    selPar.appendChild(new Option('todos los pares', ''));
    for (const e of orden) selPar.appendChild(new Option(nom(e.o) + ' → ' + nom(e.d), e.o + '>' + e.d));
    const selEstado = el('select');
    for (const v of ['todos', 'bandeja', 'insertado', 'descartado', 'revocado', 'huerfano']) {
      selEstado.appendChild(new Option(v, v));
    }
    filtros.appendChild(selPar); filtros.appendChild(selEstado);
    body.appendChild(filtros);

    const cont = el('div');
    body.appendChild(cont);
    let filas = [];
    let sel = 0;

    function pintarTabla() {
      filas = todos.slice().sort((a, b) => b.creado - a.creado);
      if (selPar.value) filas = filas.filter(p => (p.origenAgenteId + '>' + p.destinoAgenteId) === selPar.value);
      if (selEstado.value !== 'todos') filas = filas.filter(p => p.estado === selEstado.value);
      if (sel >= filas.length) sel = Math.max(0, filas.length - 1);

      vaciar(cont);
      const t = el('table', 't');
      const thead = el('thead');
      const tr = el('tr');
      for (const h of ['fecha', 'origen', 'destino', 'estado', '?', 'fragmento']) tr.appendChild(el('th', null, h));
      thead.appendChild(tr); t.appendChild(thead);
      const tb = el('tbody');
      filas.slice(0, 400).forEach((p, i) => {
        const r = el('tr');
        if (i === sel) r.classList.add('sel');
        r.appendChild(el('td', null, F.fechaCorta(p.creado)));
        r.appendChild(el('td', null, nom(p.origenAgenteId)));
        r.appendChild(el('td', null, nom(p.destinoAgenteId)));
        r.appendChild(el('td', null, p.estado));
        r.appendChild(el('td', null, p.esperaRespuesta ? '?' : ''));
        r.appendChild(el('td', 'frag', String(p.textoSnapshot || '').replace(/\s+/g, ' ').slice(0, 90)));
        r.onclick = () => { sel = i; pintarTabla(); };
        r.ondblclick = () => saltar(false);
        tb.appendChild(r);
      });
      t.appendChild(tb);
      cont.appendChild(t);
      if (!filas.length) cont.appendChild(el('div', 'vacio', 'sin pases con ese filtro'));
    }

    async function saltar(alOrigen) {
      const p = filas[sel];
      if (!p) return;
      cerrarOverlay();
      apilarSalto();
      if (alOrigen) {
        await irChat(p.origenChatId);
        if ((p.origenMensajeIds || [])[0]) destacar(p.origenMensajeIds[0]);
      } else if (p.destinoChatId) {
        await irChat(p.destinoChatId);
        if (p.destinoMensajeId) destacar(p.destinoMensajeId);
      } else {
        await irAgente(p.destinoAgenteId);
        overlayBandeja();
      }
    }

    async function revocar() {
      if (bloqueado()) return;
      const p = filas[sel];
      if (!p || p.estado === 'revocado') return;
      await F.pases.revocar(p.id);
      const i = todos.findIndex(x => x.id === p.id);
      if (i >= 0) { todos[i].estado = 'revocado'; todos[i].textoSnapshot = ''; }
      S.bandejas = await F.pases.contarBandejas();
      pintarRail(); pintarLista();
      pintarTabla();
      anunciar('pases');
      aviso('pase revocado — la instantánea se borró en el destino');
    }

    selPar.onchange = pintarTabla;
    selEstado.onchange = pintarTabla;

    document.addEventListener('keydown', teclas, true);
    function teclas(e) {
      if (overlayAbierto !== 'Conexiones') { document.removeEventListener('keydown', teclas, true); return; }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(filas.length - 1, sel + 1); pintarTabla(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); pintarTabla(); }
      else if (e.key === 'Enter') { e.preventDefault(); saltar(e.shiftKey); }
      else if (e.code === 'KeyR') { e.preventDefault(); revocar(); }
    }

    pintarTabla();
  }

  /* ------------------------------------------------------------- REPASO */

  async function overlayRepaso() {
    const { body } = abrirOverlay('Repaso', 'el bucle de retorno · Esc vuelve');

    // Abiertos por agente
    const b1 = el('div', 'bloque');
    b1.appendChild(el('h3', null, 'Mensajes abiertos'));
    let hayAbiertos = false;
    for (const a of S.agentes) {
      const ms = await F.mensajes.abiertosDe(a.id);
      if (!ms.length) continue;
      hayAbiertos = true;
      b1.appendChild(el('p', null, a.nombre + ' — ' + ms.length));
      for (const m of ms.sort((x, y) => x.creado - y.creado).slice(0, 12)) {
        const b = el('button', 'res');
        b.type = 'button';
        const dias = Math.floor((Date.now() - m.creado) / 86400000);
        b.appendChild(el('div', 'meta', F.fechaLarga(m.creado) + (dias ? ' · ' + dias + ' d' : '')));
        b.appendChild(el('div', 'linea', String(m.texto).replace(/\s+/g, ' ').slice(0, 160)));
        b.onclick = async () => { cerrarOverlay(); apilarSalto(); await irChat(m.chatId); destacar(m.id); };
        b1.appendChild(b);
      }
    }
    if (!hayAbiertos) b1.appendChild(el('p', null, 'nada marcado como abierto · Alt+P marca el mensaje enfocado'));
    body.appendChild(b1);

    // Bandejas
    const b2 = el('div', 'bloque');
    b2.appendChild(el('h3', null, 'Pases esperando en bandeja'));
    let hayBandeja = false;
    for (const [agId, e] of S.bandejas) {
      if (!e.n) continue;
      hayBandeja = true;
      const a = S.agentes.find(x => x.id === agId);
      const dias = Math.floor((Date.now() - e.masViejo) / 86400000);
      const b = el('button', 'res');
      b.type = 'button';
      b.appendChild(el('div', 'linea', (a ? a.nombre : '?') + ' — ' + e.n + (dias >= 1 ? ' · ' + dias + ' d el más viejo' : '')));
      b.onclick = async () => { cerrarOverlay(); await irAgente(agId); overlayBandeja(); };
      b2.appendChild(b);
    }
    if (!hayBandeja) b2.appendChild(el('p', null, 'ninguna bandeja pendiente'));
    body.appendChild(b2);

    // Semana
    const b3 = el('div', 'bloque');
    b3.appendChild(el('h3', null, 'Tocado en los últimos 7 días'));
    const recientes = await F.chats.recientes(200);
    const semana = recientes.filter(c => Date.now() - c.actualizado < 7 * 86400000);
    if (!semana.length) b3.appendChild(el('p', null, 'nada esta semana'));
    for (const c of semana.slice(0, 15)) {
      const a = S.agentes.find(x => x.id === c.agenteId);
      const b = el('button', 'res');
      b.type = 'button';
      b.appendChild(el('div', 'meta', (a ? a.nombre : '?') + ' · ' + F.relativo(c.actualizado)));
      b.appendChild(el('div', 'linea', c.titulo || 'Sin título'));
      b.onclick = async () => { cerrarOverlay(); await irChat(c.id); };
      b3.appendChild(b);
    }
    body.appendChild(b3);

    // Dormidos + copia
    const b4 = el('div', 'bloque');
    b4.appendChild(el('h3', null, 'Estado'));
    const dormidos = [];
    for (const a of S.agentes) {
      const cs = await F.chats.listarPorAgente(a.id);
      const ult = cs[0];
      if (!ult || Date.now() - ult.actualizado > 30 * 86400000) dormidos.push(a.nombre);
    }
    b4.appendChild(el('p', null, dormidos.length
      ? 'Sin actividad en más de 30 días: ' + dormidos.join(', ')
      : 'Todos los agentes con actividad reciente.'));
    b4.appendChild(el('p', null, S.ultimaCopia
      ? 'Última copia: ' + F.fechaLarga(S.ultimaCopia.ts) + ' ' + F.hhmm(S.ultimaCopia.ts) +
      ' · ' + (S.ultimaCopia.verificada ? 'verificada' : 'SIN VERIFICAR')
      : 'Todavía no hay ninguna copia. Alt+. › Copias.'));
    body.appendChild(b4);
  }

  /* --------------------------------------------------- FICHA DEL AGENTE */

  function overlayFicha(nuevo) {
    if (bloqueado()) return;
    const a = nuevo ? null : S.agenteActivo;
    const { body } = abrirOverlay(nuevo ? 'Agente nuevo' : 'Ficha · ' + a.nombre, 'Enter guarda · Esc cancela');

    const cNom = el('div', 'campo');
    cNom.appendChild(el('label', null, 'Nombre'));
    const iNom = el('input'); iNom.type = 'text'; iNom.value = a ? a.nombre : '';
    cNom.appendChild(iNom);
    body.appendChild(cNom);

    const fila = el('div', 'fila');
    const cGli = el('div', 'campo');
    cGli.appendChild(el('label', null, 'Glifo'));
    const iGli = el('input'); iGli.type = 'text'; iGli.maxLength = 2; iGli.value = a ? a.glifo : '';
    cGli.appendChild(iGli);
    const cPos = el('div', 'campo');
    cPos.appendChild(el('label', null, 'Posición (es el atajo Alt+N)'));
    const iPos = el('input'); iPos.type = 'number'; iPos.min = 1; iPos.value = a ? a.posicion : '';
    cPos.appendChild(iPos);
    cPos.appendChild(el('div', 'ayuda', 'Se edita como número, nunca arrastrando: el arrastre remapearía los atajos en silencio.'));
    fila.appendChild(cGli); fila.appendChild(cPos);
    body.appendChild(fila);

    const cIns = el('div', 'campo');
    cIns.appendChild(el('label', null, 'Instrucción base — qué es este agente y cómo debe responder'));
    const iIns = el('textarea'); iIns.value = a ? (a.instruccionBase || '') : '';
    cIns.appendChild(iIns);
    cIns.appendChild(el('div', 'ayuda', 'Este texto se envía verbatim al motor. Es también el único depósito de conocimiento permanente del agente: lo que fijes desde la bandeja con F se añade aquí.'));
    body.appendChild(cIns);

    // Alcance de la memoria: inclusión por acto, nunca por omisión.
    let chkAlc = null;
    if (!a || !a.esMemoria) {
      const cAlc = el('div', 'campo');
      const labA = el('label');
      chkAlc = el('input'); chkAlc.type = 'checkbox'; chkAlc.checked = a ? !!a.alcanzablePorMemoria : false;
      chkAlc.style.width = 'auto'; chkAlc.style.marginRight = '6px';
      labA.appendChild(chkAlc);
      labA.appendChild(document.createTextNode('La memoria central puede consultar este agente'));
      labA.style.textTransform = 'none'; labA.style.letterSpacing = '0'; labA.style.fontSize = '12px';
      cAlc.appendChild(labA);
      cAlc.appendChild(el('div', 'ayuda',
        'Apagado por defecto. Solo permite que la memoria LEA de aquí para ensamblar citas; no copia ni mueve nada. Déjalo apagado en los dominios cuyo material no quieras ver aparecer al preguntar desde otro sitio.'));
      body.appendChild(cAlc);
    }

    // En la ficha de Memoria: qué agentes citan cada entrada del depósito.
    if (a && a.esMemoria) {
      const entradas = F.memoria.entradasDeposito(a.instruccionBase || '');
      if (entradas.size) {
        const cRef = el('div', 'campo');
        cRef.appendChild(el('label', null, 'Entradas del depósito y quién las cita'));
        const t = el('table', 't');
        const tb = el('tbody');
        for (const [clave, e] of entradas) {
          const citantes = S.agentes.filter(x => !x.esMemoria &&
            new RegExp('^\\s*@memoria:' + clave + '\\b', 'im').test(x.instruccionBase || ''));
          const tr = el('tr');
          tr.appendChild(el('td', null, '@memoria:' + clave));
          tr.appendChild(el('td', 'num', e.cuerpo.length + ' car.'));
          tr.appendChild(el('td', null, citantes.length
            ? 'citada por: ' + citantes.map(x => x.nombre).join(', ')
            : 'no la cita nadie — no viaja a ninguna petición'));
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        cRef.appendChild(t);
        body.appendChild(cRef);
      }
    }

    const cAuto = el('div', 'campo');
    const lab = el('label');
    const chk = el('input'); chk.type = 'checkbox'; chk.checked = a ? !!a.permitePaseAutomatico : false;
    chk.style.width = 'auto'; chk.style.marginRight = '6px';
    lab.appendChild(chk);
    lab.appendChild(document.createTextNode('Permitir que el motor emita pases desde este agente'));
    lab.style.textTransform = 'none';
    lab.style.letterSpacing = '0';
    lab.style.fontSize = '12px';
    cAuto.appendChild(lab);
    cAuto.appendChild(el('div', 'ayuda', 'Apagado por defecto. Aunque se encienda, los pases del motor aterrizan siempre en la bandeja, nunca se insertan solos.'));
    body.appendChild(cAuto);

    const btns = el('div', 'btns');
    const bGuardar = el('button', null, nuevo ? 'Crear agente' : 'Guardar');
    bGuardar.type = 'button';
    btns.appendChild(bGuardar);

    if (a && !a.fijo) {
      const bBorrar = el('button', 'peligro der', 'Borrar agente…');
      bBorrar.type = 'button';
      bBorrar.onclick = () => borrarAgente(a);
      btns.appendChild(bBorrar);
    }
    body.appendChild(btns);

    async function guardar() {
      const nombre = iNom.value.trim();
      if (!nombre) { iNom.focus(); return; }
      await conError('ficha', async () => {
        if (nuevo) {
          const creado = await F.agentes.crear({
            nombre,
            glifo: iGli.value.trim() || nombre.slice(0, 2),
            posicion: parseInt(iPos.value, 10) || 0,
            instruccionBase: iIns.value,
            permitePaseAutomatico: chk.checked
          });
          if (chkAlc && chkAlc.checked) {
            creado.alcanzablePorMemoria = true;
            await F.agentes.guardar(creado);
          }
          S.agentes = await F.agentes.listar();
          cerrarOverlay();
          anunciar('agentes');
          await irAgente(creado.id);
          await nuevoChat();
          aviso('agente creado');
        } else {
          a.nombre = nombre;
          a.glifo = (iGli.value.trim() || nombre.slice(0, 2)).toUpperCase();
          const p = parseInt(iPos.value, 10);
          if (p > 0) a.posicion = p;
          a.instruccionBase = iIns.value;
          a.permitePaseAutomatico = chk.checked;
          if (chkAlc) a.alcanzablePorMemoria = chkAlc.checked;
          await F.agentes.guardar(a);
          S.agentes = await F.agentes.listar();
          cerrarOverlay();
          pintarRail(); pintarLista(); pintarEstado();
          anunciar('agentes');
          aviso('ficha guardada');
        }
      });
    }

    bGuardar.onclick = guardar;
    iNom.onkeydown = iGli.onkeydown = iPos.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); guardar(); }
    };
    setTimeout(() => iNom.focus(), 0);
  }

  function borrarAgente(a) {
    const { body } = abrirOverlay('Borrar ' + a.nombre, 'confirmación escrita obligatoria');
    body.appendChild(el('p', null, 'Esta operación no se puede deshacer.'));

    const cDest = el('div', 'campo');
    cDest.appendChild(el('label', null, 'Qué hacer con sus chats'));
    const sel = el('select');
    sel.appendChild(new Option('Borrarlos también', ''));
    for (const o of S.agentes) if (o.id !== a.id) sel.appendChild(new Option('Moverlos a ' + o.nombre, o.id));
    cDest.appendChild(sel);
    body.appendChild(cDest);

    const cConf = el('div', 'campo');
    cConf.appendChild(el('label', null, 'Escribe el nombre del agente para confirmar'));
    const inp = el('input'); inp.type = 'text';
    cConf.appendChild(inp);
    body.appendChild(cConf);

    body.appendChild(el('p', null, 'Los pases emitidos y recibidos conservan su instantánea y quedan marcados como huérfanos.'));

    const btns = el('div', 'btns');
    const b = el('button', 'peligro', 'Borrar definitivamente');
    b.type = 'button';
    b.onclick = async () => {
      if (inp.value.trim() !== a.nombre) { aviso('el nombre no coincide', true); return; }
      await conError('borrar-agente', async () => {
        await F.agentes.borrar(a.id, sel.value || null);
        S.agentes = await F.agentes.listar();
        cerrarOverlay();
        anunciar('agentes');
        await irAgente(S.agentes[0].id);
        aviso('agente borrado');
      });
    };
    btns.appendChild(b);
    body.appendChild(btns);
    setTimeout(() => inp.focus(), 0);
  }

  /* ------------------------------------------------------- MANTENIMIENTO */

  async function overlayMantenimiento() {
    const { body } = abrirOverlay('Mantenimiento', 'copias · importar · purga · integridad · errores');

    // --- Copias
    const b1 = el('div', 'bloque');
    b1.appendChild(el('h3', null, 'Copias de seguridad'));
    const est = el('p');
    est.textContent = S.ultimaCopia
      ? 'Última: ' + F.fechaLarga(S.ultimaCopia.ts) + ' ' + F.hhmm(S.ultimaCopia.ts) +
      ' · ' + Math.round(S.ultimaCopia.bytes / 1024) + ' KB · ' +
      (S.ultimaCopia.verificada ? 'verificada (releída y comprobada)' : 'SIN VERIFICAR')
      : 'Todavía no hay ninguna copia.';
    b1.appendChild(est);
    b1.appendChild(el('p', null, S.dirCopia
      ? 'Carpeta de copias configurada. Se copia al arrancar, al cerrar y cada 50 mensajes.'
      : 'Sin carpeta de copias. Elige una y las copias se escribirán solas.'));

    const cPass = el('div', 'campo');
    cPass.appendChild(el('label', null, 'Contraseña para cifrar el archivo exportado (opcional)'));
    const iPass = el('input'); iPass.type = 'password'; iPass.placeholder = 'vacío = sin cifrar';
    cPass.appendChild(iPass);
    cPass.appendChild(el('div', 'ayuda', 'Cifra el archivo que SALE de la máquina (AES-GCM). La base local no se cifra: la clave viviría en el mismo sitio y rompería el índice.'));
    b1.appendChild(cPass);

    const btns1 = el('div', 'btns');
    const bDir = el('button', null, 'Elegir carpeta de copias…');
    bDir.type = 'button';
    bDir.onclick = () => elegirCarpetaCopias();
    const bYa = el('button', null, 'Copiar ahora');
    bYa.type = 'button';
    bYa.onclick = () => copiaAutomatica('manual', iPass.value);
    const bDesc = el('button', null, 'Descargar volcado');
    bDesc.type = 'button';
    bDesc.onclick = () => descargarVolcado(iPass.value);
    btns1.appendChild(bDir); btns1.appendChild(bYa); btns1.appendChild(bDesc);
    b1.appendChild(btns1);

    const hist = await F.copias.listar();
    if (hist.length) {
      const t = el('table', 't');
      t.style.marginTop = '10px';
      const tb = el('tbody');
      for (const c of hist.slice(0, 8)) {
        const tr = el('tr');
        tr.appendChild(el('td', null, F.fechaLarga(c.ts) + ' ' + F.hhmm(c.ts)));
        tr.appendChild(el('td', null, c.nombreArchivo));
        tr.appendChild(el('td', 'num', Math.round(c.bytes / 1024) + ' KB'));
        tr.appendChild(el('td', null, c.verificada ? 'verificada' : '—'));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      b1.appendChild(t);
    }
    body.appendChild(b1);

    // --- Importar
    const b2 = el('div', 'bloque');
    b2.appendChild(el('h3', null, 'Importar / restaurar'));
    b2.appendChild(el('p', null, 'Un respaldo que nunca se ha restaurado no es un respaldo, es un archivo.'));
    const inpFile = el('input'); inpFile.type = 'file'; inpFile.accept = '.json,.fluens';
    b2.appendChild(inpFile);
    const cModo = el('div', 'campo');
    cModo.style.marginTop = '8px';
    cModo.appendChild(el('label', null, 'Modo'));
    const selModo = el('select');
    selModo.appendChild(new Option('Fusionar (gana la versión más reciente)', 'fusionar'));
    selModo.appendChild(new Option('Reemplazar todo (borra lo actual)', 'reemplazar'));
    cModo.appendChild(selModo);
    b2.appendChild(cModo);
    const cPass2 = el('div', 'campo');
    cPass2.appendChild(el('label', null, 'Contraseña si el archivo está cifrado'));
    const iPass2 = el('input'); iPass2.type = 'password';
    cPass2.appendChild(iPass2);
    b2.appendChild(cPass2);
    const btns2 = el('div', 'btns');
    const bImp = el('button', null, 'Importar');
    bImp.type = 'button';
    bImp.onclick = () => importar(inpFile.files[0], selModo.value, iPass2.value, b2);
    btns2.appendChild(bImp);
    b2.appendChild(btns2);
    body.appendChild(b2);

    // --- Purga
    const b3 = el('div', 'bloque');
    b3.appendChild(el('h3', null, 'Purga verificable'));
    b3.appendChild(el('p', null, 'Busca una cadena en TODO —mensajes, borradores, previsualizaciones, títulos, instantáneas de pases en otros agentes, notas, instrucciones base e índice— y la elimina de todas partes.'));
    const cPur = el('div', 'campo');
    const iPur = el('input'); iPur.type = 'text'; iPur.placeholder = 'cadena exacta a eliminar';
    cPur.appendChild(iPur);
    b3.appendChild(cPur);
    const btns3 = el('div', 'btns');
    const bPur = el('button', 'peligro', 'Purgar de todas partes');
    bPur.type = 'button';
    bPur.onclick = async () => {
      if (bloqueado()) return;
      const cadena = iPur.value;
      if (!cadena || cadena.length < 2) { aviso('escribe la cadena exacta', true); return; }
      await conError('purga', async () => {
        const c = await F.mantenimiento.purgar(cadena);
        const r = el('p');
        r.textContent = 'Eliminadas ' + c.apariciones + ' apariciones: ' +
          c.mensajes + ' mensajes, ' + c.chats + ' chats, ' + c.pases + ' pases, ' + c.agentes + ' agentes. ' +
          'Las copias anteriores siguen conteniéndola: genera una copia nueva y borra las viejas.';
        b3.appendChild(r);
        await refrescarChatActual();
        anunciar('mensajes');
      });
    };
    btns3.appendChild(bPur);
    b3.appendChild(btns3);
    body.appendChild(b3);

    // --- Integridad, cuota, índice
    const b4 = el('div', 'bloque');
    b4.appendChild(el('h3', null, 'Integridad y almacenamiento'));
    const cuota = await F.mantenimiento.cuota();
    if (cuota) {
      b4.appendChild(el('p', null,
        'Uso: ' + (cuota.usage / 1048576).toFixed(1) + ' MB de ' +
        (cuota.quota / 1048576).toFixed(0) + ' MB disponibles.'));
    }
    const persistido = navigator.storage && navigator.storage.persisted
      ? await navigator.storage.persisted() : false;
    b4.appendChild(el('p', null, persistido
      ? 'Almacenamiento persistente concedido: el navegador no puede desalojar la base.'
      : 'Almacenamiento NO persistente: el navegador podría desalojar la base bajo presión de disco. Las copias son tu red.'));
    const salida = el('p', 'cifra');
    b4.appendChild(salida);
    const btns4 = el('div', 'btns');
    const bInt = el('button', null, 'Comprobar integridad');
    bInt.type = 'button';
    bInt.onclick = async () => {
      const r = await F.mantenimiento.integridad();
      salida.textContent = r.mensajes + ' mensajes · ' + r.chats + ' chats · ' +
        r.chatsCorregidos + ' contadores corregidos · ' +
        r.indiceSobrante + ' entradas de índice sobrantes eliminadas · ' +
        r.huerfanos + ' mensajes huérfanos';
      await refrescarChatActual();
    };
    const bIdx = el('button', null, 'Reconstruir índice');
    bIdx.type = 'button';
    bIdx.onclick = async () => {
      if (bloqueado()) return;
      salida.textContent = 'reconstruyendo…';
      const n = await F.mantenimiento.reconstruirIndice((hecho, total) => {
        salida.textContent = 'reconstruyendo… ' + hecho + '/' + total;
      });
      salida.textContent = 'índice reconstruido sobre ' + n + ' mensajes';
    };
    btns4.appendChild(bInt); btns4.appendChild(bIdx);
    b4.appendChild(btns4);
    body.appendChild(b4);

    // --- Pendientes del motor
    const pend = await F.mensajes.pendientes();
    const b5 = el('div', 'bloque');
    b5.appendChild(el('h3', null, 'Cola del motor'));
    b5.appendChild(el('p', null, pend.length
      ? pend.length + ' mensajes quedaron pendientes (se escribieron con el motor ausente). Son reenviables en bloque el día que el motor exista.'
      : 'Nada pendiente.'));
    body.appendChild(b5);

    // --- Errores
    const errs = await F.errores.listar(30);
    const b6 = el('div', 'bloque');
    b6.appendChild(el('h3', null, 'Errores'));
    if (!errs.length) b6.appendChild(el('p', null, 'Ninguno registrado.'));
    else {
      const t = el('table', 't');
      const tb = el('tbody');
      for (const e of errs) {
        const tr = el('tr');
        tr.appendChild(el('td', null, F.fechaCorta(e.ts) + ' ' + F.hhmm(e.ts)));
        tr.appendChild(el('td', null, e.tipo));
        tr.appendChild(el('td', 'frag', e.mensaje));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      b6.appendChild(t);
      const btns6 = el('div', 'btns');
      const bl = el('button', null, 'Vaciar registro');
      bl.type = 'button';
      bl.onclick = async () => { await F.errores.limpiar(); overlayMantenimiento(); };
      btns6.appendChild(bl);
      b6.appendChild(btns6);
    }
    body.appendChild(b6);
  }

  /* ================================================================ COPIAS */

  async function elegirCarpetaCopias() {
    if (!window.showDirectoryPicker) { aviso('este navegador no permite elegir carpeta; usa "Descargar volcado"', true); return; }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
      S.dirCopia = dir;
      S.ui.dirCopia = dir;               // los handles se pueden guardar en IDB
      await guardarUI();
      aviso('carpeta de copias configurada');
      copiaAutomatica('manual');
    } catch (_) { /* cancelado */ }
  }

  async function permisoCarpeta(dir) {
    if (!dir || !dir.queryPermission) return false;
    const o = { mode: 'readwrite' };
    if ((await dir.queryPermission(o)) === 'granted') return true;
    return (await dir.requestPermission(o)) === 'granted';
  }

  function nombreCopia() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return 'fluens-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + '.json';
  }

  async function cifrar(txt, pass) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const clave = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, enc.encode(txt));
    const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
    return JSON.stringify({ formato: 'fluens-volcado-cifrado', v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
  }

  async function descifrar(obj, pass) {
    const dec = new TextDecoder();
    const u8 = (b) => Uint8Array.from(atob(b), c => c.charCodeAt(0));
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const clave = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: u8(obj.salt), iterations: 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8(obj.iv) }, clave, u8(obj.ct));
    return JSON.parse(dec.decode(pt));
  }

  async function copiaAutomatica(motivo, pass) {
    if (S.soloLectura) return;
    const dir = S.dirCopia || (S.ui && S.ui.dirCopia);
    if (!dir) return;
    await conError('copia', async () => {
      if (!(await permisoCarpeta(dir))) { aviso('permiso de carpeta no concedido — Alt+. para reautorizar', true); return; }
      S.dirCopia = dir;
      const volcado = await F.copias.volcar();
      let txt = JSON.stringify(volcado);
      if (pass) txt = await cifrar(txt, pass);

      const nombre = nombreCopia();
      const fh = await dir.getFileHandle(nombre, { create: true });
      const w = await fh.createWritable();
      await w.write(txt);
      await w.close();

      // Verificación: una copia nunca releída no es una copia.
      let verificada = false;
      try {
        const leido = await (await fh.getFile()).text();
        const parsed = JSON.parse(leido);
        verificada = pass
          ? parsed.formato === 'fluens-volcado-cifrado'
          : (parsed.datos && parsed.datos.mensajes &&
            parsed.datos.mensajes.length === volcado.datos.mensajes.length);
      } catch (_) { verificada = false; }

      await F.copias.registrar(nombre, txt.length, verificada);
      S.ultimaCopia = await F.copias.ultima();
      S.desdeUltimaCopia = 0;
      pintarEstado();
      await rotarCopias(dir);
      if (motivo === 'manual') aviso('copia escrita' + (verificada ? ' y verificada' : ' pero NO verificada'), !verificada);
    });
  }

  async function rotarCopias(dir) {
    try {
      const nombres = [];
      for await (const [nombre, h] of dir.entries()) {
        if (h.kind === 'file' && /^fluens-\d{8}-\d{4}\.json$/.test(nombre)) nombres.push(nombre);
      }
      nombres.sort();
      // 7 diarias + 4 semanales: se conservan las 7 últimas y una por semana.
      const conservar = new Set(nombres.slice(-7));
      const porSemana = new Map();
      for (const n of nombres) {
        const m = n.match(/^fluens-(\d{4})(\d{2})(\d{2})/);
        if (!m) continue;
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        const semana = Math.floor(d.getTime() / (7 * 86400000));
        porSemana.set(semana, n);
      }
      [...porSemana.values()].slice(-4).forEach(n => conservar.add(n));
      for (const n of nombres) if (!conservar.has(n)) await dir.removeEntry(n);
    } catch (_) { /* rotación es cortesía, no obligación */ }
  }

  async function descargarVolcado(pass) {
    await conError('descargar', async () => {
      const volcado = await F.copias.volcar();
      let txt = JSON.stringify(volcado, null, 1);
      if (pass) txt = await cifrar(txt, pass);
      const blob = new Blob([txt], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nombreCopia();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      await F.copias.registrar(a.download, txt.length, false);
      S.ultimaCopia = await F.copias.ultima();
      pintarEstado();
    });
  }

  async function importar(file, modo, pass, contenedor) {
    if (bloqueado()) return;
    if (!file) { aviso('elige un archivo primero', true); return; }
    await conError('importar', async () => {
      const txt = await file.text();
      let obj = JSON.parse(txt);
      if (obj.formato === 'fluens-volcado-cifrado') {
        if (!pass) { aviso('el archivo está cifrado: escribe la contraseña', true); return; }
        obj = await descifrar(obj, pass);
      }
      const informe = await F.copias.importar(obj, modo);
      const p = el('p');
      p.textContent = 'Importado: ' +
        Object.entries(informe.entraron).map(([k, v]) => v + ' ' + k).join(', ') +
        '. Omitidos por ser más antiguos: ' +
        Object.entries(informe.omitidos).map(([k, v]) => v + ' ' + k).join(', ') +
        (informe.faltaban.length ? '. Faltaban en el archivo: ' + informe.faltaban.join(', ') : '.');
      contenedor.appendChild(p);
      S.agentes = await F.agentes.listar();
      S.ui = await F.estado.leer();
      S.bandejas = await F.pases.contarBandejas();
      anunciar('agentes');
      await irAgente(S.agentes[0].id);
      aviso('importación terminada');
    });
  }

  /* ============================================================== ACCIONES */

  async function alternarFijado() {
    if (bloqueado() || !S.chatActivo || S.chatActivo.virtual) return;
    const c = S.chatActivo;
    if (!c.fijado) {
      const n = S.chats.filter(x => x.fijado).length;
      if (n >= 6) { aviso('máximo 6 fijados — fijar es memoria de trabajo, no archivo', true); return; }
    }
    const antes = c.fijado;
    c.fijado = c.fijado ? 0 : 1;
    await F.chats.guardar(c);
    S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
    pintarLista(); pintarHilo();
    ofrecerDeshacer(antes ? 'chat desfijado' : 'chat fijado', async () => {
      c.fijado = antes;
      await F.chats.guardar(c);
      S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
      pintarLista(); pintarHilo();
    });
  }

  async function alternarArchivado() {
    if (bloqueado() || !S.chatActivo || S.chatActivo.virtual) return;
    const c = S.chatActivo;
    const antes = c.archivado;
    c.archivado = c.archivado ? 0 : 1;
    await F.chats.guardar(c);
    S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
    pintarLista();
    anunciar('chats');
    ofrecerDeshacer(antes ? 'chat desarchivado' : 'chat archivado', async () => {
      c.archivado = antes;
      await F.chats.guardar(c);
      S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
      pintarLista();
    });
    if (c.archivado) {
      const siguiente = S.chats[0];
      if (siguiente) await irChat(siguiente.id);
      else await nuevoChat();
    }
  }

  function renombrarChat() {
    if (bloqueado() || !S.chatActivo) return;
    const path = $('thread-path');
    const c = S.chatActivo;
    vaciar(path);
    const inp = el('input', 'tit-edit');
    inp.type = 'text';
    inp.value = c.titulo || '';
    path.appendChild(inp);
    inp.focus(); inp.select();
    const terminar = async (guardar) => {
      if (guardar) {
        const v = inp.value.trim();
        if (v) {
          c.titulo = v;
          c.tituloManual = true;
          if (c.virtual) { c.virtual = false; }
          await F.chats.guardar(c);
          S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
          marcarGuardado();
          anunciar('chats');
        }
      }
      pintarLista(); pintarHilo(); pintarEstado();
      $('composer').focus();
    };
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); terminar(true); }
      if (e.key === 'Escape') { e.preventDefault(); terminar(false); }
    };
    inp.onblur = () => terminar(true);
  }

  function moverChat() {
    if (bloqueado() || !S.chatActivo || S.chatActivo.virtual) return;
    const { body } = abrirOverlay('Mover chat a otro agente', 'Enter confirma · Esc cancela');
    body.appendChild(el('p', null, '« ' + (S.chatActivo.titulo || 'Sin título') + ' »'));
    const sel = el('select');
    for (const a of S.agentes) {
      if (a.id === S.agenteActivo.id) continue;
      sel.appendChild(new Option(a.nombre, a.id));
    }
    const c = el('div', 'campo');
    c.appendChild(el('label', null, 'Agente destino'));
    c.appendChild(sel);
    body.appendChild(c);
    const btns = el('div', 'btns');
    const b = el('button', null, 'Mover');
    b.type = 'button';
    b.onclick = async () => {
      const destino = sel.value;
      const origen = S.agenteActivo.id;
      const chatId = S.chatActivo.id;
      await F.chats.moverAgente(chatId, destino);
      cerrarOverlay();
      anunciar('chats');
      await irAgente(destino);
      await irChat(chatId);
      ofrecerDeshacer('chat movido', async () => {
        await F.chats.moverAgente(chatId, origen);
        await irAgente(origen);
        await irChat(chatId);
      });
    };
    btns.appendChild(b);
    body.appendChild(btns);
    setTimeout(() => sel.focus(), 0);
  }

  async function derivarChat() {
    if (bloqueado() || !S.chatActivo || !S.marcados.size) {
      aviso('marca los mensajes que quieres llevarte (Espacio) y pulsa Alt+Shift+D');
      return;
    }
    const origen = S.chatActivo;
    const c = F.chats.nuevoVirtual(S.agenteActivo.id);
    c.virtual = false;
    c.titulo = (origen.titulo || 'Sin título') + ' · derivado';
    c.tituloManual = true;
    c.derivadoDeChatId = origen.id;
    await F.chats.guardar(c);
    for (const m of S.mensajes) {
      if (!S.marcados.has(m.id)) continue;
      await F.mensajes.crear(c, {
        rol: m.rol, texto: m.texto,
        procedencia: {
          etiqueta: S.agenteActivo.nombre + ' · «' + (origen.titulo || 'sin título') + '»',
          agenteId: S.agenteActivo.id, chatId: origen.id, mensajeId: m.id
        }
      });
    }
    S.marcados.clear();
    S.chats = await F.chats.listarPorAgente(S.agenteActivo.id);
    await irChat(c.id);
    aviso('chat derivado — el original queda intacto');
  }

  async function copiarMensaje(todoElChat) {
    let txt;
    if (todoElChat) {
      txt = S.mensajes.map(m => (m.rol === 'usuario' ? '> ' : '') + m.texto).join('\n\n---\n\n');
    } else if (S.focoMsgId) {
      const m = S.mensajes.find(x => x.id === S.focoMsgId);
      txt = m ? m.texto : '';
    } else if (S.marcados.size) {
      txt = S.mensajes.filter(m => S.marcados.has(m.id)).map(m => m.texto).join('\n\n');
    } else return aviso('nada enfocado ni marcado');
    try {
      await navigator.clipboard.writeText(txt);
      aviso(todoElChat ? 'chat copiado en Markdown' : 'copiado');
    } catch (_) { aviso('no se pudo copiar', true); }
  }

  function editarMensaje() {
    if (bloqueado() || !S.focoMsgId) { aviso('enfoca un mensaje primero'); return; }
    const m = S.mensajes.find(x => x.id === S.focoMsgId);
    if (!m) return;
    const { body } = abrirOverlay('Editar mensaje', 'no hay historial de versiones: versionar contradice poder borrar');
    const c = el('div', 'campo');
    const ta = el('textarea');
    ta.value = m.texto;
    ta.style.minHeight = '260px';
    c.appendChild(ta);
    body.appendChild(c);
    const btns = el('div', 'btns');
    const b = el('button', null, 'Guardar');
    b.type = 'button';
    b.onclick = async () => {
      await F.mensajes.editar(m.id, ta.value);
      cerrarOverlay();
      await refrescarChatActual();
      marcarGuardado();
      anunciar('mensajes');
    };
    btns.appendChild(b);
    body.appendChild(btns);
    setTimeout(() => ta.focus(), 0);
  }

  async function borrarMensaje() {
    if (bloqueado() || !S.focoMsgId) return;
    const m = S.mensajes.find(x => x.id === S.focoMsgId);
    if (!m) return;
    const copia = Object.assign({}, m);
    await F.mensajes.borrar(m.id);
    S.focoMsgId = null;
    await refrescarChatActual();
    anunciar('mensajes');
    ofrecerDeshacer('mensaje borrado', async () => {
      await F.mensajes.guardar(copia);
      await F.mantenimiento.reconstruirIndice();
      await refrescarChatActual();
    });
  }

  async function marcarAbierto() {
    if (bloqueado() || !S.focoMsgId) { aviso('enfoca un mensaje y vuelve a pulsar Alt+P'); return; }
    const m = S.mensajes.find(x => x.id === S.focoMsgId);
    if (!m) return;
    await F.mensajes.marcarAbierto(m.id, !m.abierto);
    await refrescarChatActual();
    aviso(m.abierto ? 'ya no está marcado como abierto' : 'marcado como abierto — aparece en Alt+0');
  }

  function localizarEnChat() {
    const { body } = abrirOverlay('Localizar en este chat', 'Enter salta a la siguiente coincidencia');
    const c = el('div', 'campo');
    const inp = el('input'); inp.type = 'text';
    c.appendChild(inp);
    body.appendChild(c);
    const res = el('div');
    body.appendChild(res);
    let hits = [];
    let i = 0;
    inp.oninput = () => {
      const q = F.sinAcentos(inp.value.toLowerCase().trim());
      hits = q ? S.mensajes.filter(m => F.sinAcentos(m.texto.toLowerCase()).includes(q)) : [];
      i = 0;
      vaciar(res);
      res.appendChild(el('p', null, hits.length ? hits.length + ' coincidencias' : (q ? 'ninguna' : '')));
      S.resaltar = q ? [q] : null;
    };
    inp.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!hits.length) return;
      const m = hits[i % hits.length];
      i++;
      cerrarOverlay();
      destacar(m.id);
    };
    setTimeout(() => inp.focus(), 0);
  }

  async function nuevoChatEnOtroAgente() {
    const { body } = abrirOverlay('Nuevo chat en…', 'escribe, ↑↓ mueve, Enter abre');
    const inp = el('input', 'ov-input');
    inp.type = 'text';
    body.appendChild(inp);
    const lista = el('div', 'destino-lista');
    lista.style.marginTop = '10px';
    body.appendChild(lista);
    let idx = 0;
    const cands = () => {
      const q = F.sinAcentos(inp.value.toLowerCase().trim());
      return S.agentes.filter(a => !q || F.sinAcentos(a.nombre.toLowerCase()).includes(q));
    };
    function pintar() {
      vaciar(lista);
      cands().forEach((a, i) => {
        const b = el('button', 'destino' + (i === idx ? ' sel' : ''));
        b.type = 'button';
        b.appendChild(el('span', 'marca', a.posicion <= 9 ? String(a.posicion) : ''));
        b.appendChild(el('span', null, a.nombre));
        b.onclick = () => { idx = i; abrir(); };
        lista.appendChild(b);
      });
    }
    async function abrir() {
      const a = cands()[idx];
      if (!a) return;
      cerrarOverlay();
      await irAgente(a.id);
      await nuevoChat();
    }
    inp.oninput = () => { idx = 0; pintar(); };
    inp.onkeydown = (e) => {
      const cs = cands();
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(cs.length - 1, idx + 1); pintar(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); pintar(); }
      else if (e.key === 'Enter') { e.preventDefault(); abrir(); }
    };
    pintar();
    setTimeout(() => inp.focus(), 0);
  }

  async function alternarUltimos() {
    const d = S.ui.ultimosDosChats || [];
    const otro = d.find(id => !S.chatActivo || id !== S.chatActivo.id);
    if (!otro) { aviso('todavía no hay dos chats visitados'); return; }
    await irChat(otro);
  }

  /* ================================================================ TECLADO */

  function moverFoco(delta) {
    if (!S.mensajes.length) return;
    let i = S.focoMsgId ? S.mensajes.findIndex(m => m.id === S.focoMsgId) : S.mensajes.length;
    i = Math.max(0, Math.min(S.mensajes.length - 1, i + delta));
    S.focoMsgId = S.mensajes[i].id;
    const desdeElFinal = S.mensajes.length - i;
    if (desdeElFinal > S.ventana) { S.ventana = desdeElFinal + 20; }
    pintarHilo(); pintarEstado();
    const n = document.querySelector('.msg[data-id="' + S.focoMsgId + '"]');
    if (n) n.scrollIntoView({ block: 'nearest' });
  }

  function teclas(e) {
    // --- Esc cierra superposiciones
    if (e.key === 'Escape' && !e.altKey) {
      if (overlayAbierto) { e.preventDefault(); S.resaltar = null; cerrarOverlay(); pintarHilo(); }
      else { e.preventDefault(); S.zona = 'composer'; $('composer').focus(); }
      return;
    }

    // --- Modo discreto
    if (e.altKey && e.key === 'Escape') {
      e.preventDefault();
      const v = $('velo');
      v.hidden = !v.hidden;
      if (v.hidden) $('composer').focus();
      return;
    }
    if (!$('velo').hidden) { e.preventDefault(); return; }

    // --- Dentro de una superposición, el resto de atajos Alt sigue activo,
    //     pero las teclas sueltas las gestiona la propia superposición.
    if (!e.altKey) {
      if (overlayAbierto) return;
      if (e.target === $('composer')) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
        return;
      }
      if (S.zona === 'thread') {
        if (e.key === 'ArrowUp') { e.preventDefault(); moverFoco(-1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); moverFoco(1); }
        else if (e.key === ' ') {
          e.preventDefault();
          if (S.focoMsgId) {
            if (S.marcados.has(S.focoMsgId)) S.marcados.delete(S.focoMsgId);
            else S.marcados.add(S.focoMsgId);
            pintarHilo();
          }
        } else if (e.key === 'Home') { e.preventDefault(); S.ventana = S.mensajes.length; S.focoMsgId = (S.mensajes[0] || {}).id; pintarHilo(); }
        else if (e.key === 'End') { e.preventDefault(); S.focoMsgId = (S.mensajes[S.mensajes.length - 1] || {}).id; pintarHilo(); $('thread-scroll').scrollTop = $('thread-scroll').scrollHeight; }
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const orden = ['rail', 'list', 'thread', 'composer'];
        let i = orden.indexOf(S.zona);
        i = (i + (e.shiftKey ? -1 : 1) + orden.length) % orden.length;
        S.zona = orden[i];
        if (S.zona === 'composer') $('composer').focus();
        else $(S.zona === 'thread' ? 'thread-scroll' : S.zona).focus();
      }
      return;
    }

    // --- A partir de aquí: Alt está pulsado
    const c = e.code;

    // Agentes por posición
    if (/^Digit[1-9]$/.test(c) && !e.shiftKey) {
      e.preventDefault();
      const n = +c.slice(5);
      const a = S.agentes.find(x => x.posicion === n);
      if (a) irAgente(a.id); else aviso('no hay agente en la posición ' + n);
      return;
    }

    const acciones = {
      Digit0: () => overlayRepaso(),
      KeyK: () => overlayPaleta(),
      KeyQ: () => alternarUltimos(),
      BracketLeft: () => volverSalto(),
      BracketRight: () => volverSalto(),
      ArrowUp: () => moverChatLista(-1),
      ArrowDown: () => moverChatLista(1),
      KeyN: () => (e.shiftKey ? nuevoChatEnOtroAgente() : nuevoChat()),
      KeyD: () => (e.shiftKey ? derivarChat() : aviso('Alt+Shift+D deriva el chat (Alt+D lo usa el navegador)')),
      KeyR: () => renombrarChat(),
      F2: () => renombrarChat(),
      KeyF: () => alternarFijado(),
      KeyA: () => (e.shiftKey ? overlayFicha(true) : alternarArchivado()),
      KeyM: () => (e.shiftKey ? moverChat() : alternarMemoria()),
      KeyV: () => (e.shiftKey ? verCargaUtil() : aviso('Alt+Shift+V muestra la carga útil exacta')),
      KeyB: () => alternarLista(),
      KeyL: () => localizarEnChat(),
      KeyS: () => abrirPase(e.shiftKey),
      KeyJ: () => overlayBandeja(),
      KeyG: () => overlayConexiones(),
      KeyP: () => marcarAbierto(),
      KeyE: () => editarMensaje(),
      Delete: () => borrarMensaje(),
      KeyC: () => copiarMensaje(e.shiftKey),
      KeyZ: () => hacerDeshacer(),
      Comma: () => overlayFicha(false),
      Period: () => overlayMantenimiento()
    };

    const fn = acciones[c];
    if (fn) { e.preventDefault(); fn(); }
  }

  async function moverChatLista(delta) {
    if (!S.chats.length) return;
    let i = S.chatActivo ? S.chats.findIndex(x => x.id === S.chatActivo.id) : -1;
    i = Math.max(0, Math.min(S.chats.length - 1, i + delta));
    await irChat(S.chats[i].id);
  }

  // Debe coincidir con el punto de ruptura de app.css donde la lista pasa a
  // superposición. Si se separan, Alt+B deja de hacer nada.
  const ANCHO_LISTA_FLOTANTE = 720;

  function alternarLista() {
    const app = $('app');
    if (window.innerWidth <= ANCHO_LISTA_FLOTANTE) app.classList.toggle('lista-flotante');
    else app.classList.toggle('sin-lista');
    S.ui.listaColapsada = app.classList.contains('sin-lista');
    guardarUI();
  }

  async function hacerDeshacer() {
    const d = S.deshacer;
    if (!d) { aviso('nada que deshacer'); return; }
    if (Date.now() > d.hasta + 60000) { aviso('la ventana de deshacer expiró'); S.deshacer = null; return; }
    S.deshacer = null;
    await conError('deshacer', d.fn);
    aviso('deshecho: ' + d.txt);
  }

  /* ================================================================ CABLEAR */

  let tBorrador = null;

  function ajustarCompositor() {
    const t = $('composer');
    t.style.height = 'auto';
    t.style.height = Math.min(220, Math.max(58, t.scrollHeight)) + 'px';
  }

  async function guardarUI() {
    if (S.soloLectura) return;
    try { await F.estado.guardar(S.ui); } catch (_) { }
  }

  function cablear() {
    document.addEventListener('keydown', teclas, false);

    const comp = $('composer');
    comp.addEventListener('input', () => {
      ajustarCompositor();
      clearTimeout(tBorrador);
      tBorrador = setTimeout(() => guardarBorrador(), 300);
    });
    comp.addEventListener('focus', () => { S.zona = 'composer'; });
    comp.addEventListener('paste', (e) => {
      // El pegado se toma siempre como texto plano.
      const txt = (e.clipboardData || window.clipboardData).getData('text/plain');
      e.preventDefault();
      const t = e.target;
      const ini = t.selectionStart, fin = t.selectionEnd;
      t.value = t.value.slice(0, ini) + txt + t.value.slice(fin);
      t.selectionStart = t.selectionEnd = ini + txt.length;
      ajustarCompositor();
      clearTimeout(tBorrador);
      tBorrador = setTimeout(() => guardarBorrador(), 300);
    });

    $('thread-scroll').addEventListener('focus', () => { S.zona = 'thread'; });
    $('thread-scroll').addEventListener('scroll', () => {
      if (!S.chatActivo || S.chatActivo.virtual) return;
      S.ui.scrollPorChat = S.ui.scrollPorChat || {};
      S.ui.scrollPorChat[S.chatActivo.id] = $('thread-scroll').scrollTop;
    });
    $('rail').addEventListener('focus', () => { S.zona = 'rail'; });
    $('list').addEventListener('focus', () => { S.zona = 'list'; });

    $('thread-older').querySelector('button').onclick = () => {
      S.ventana += 80;
      const sc = $('thread-scroll');
      const antes = sc.scrollHeight;
      pintarHilo();
      sc.scrollTop = sc.scrollHeight - antes;
    };

    $('btn-nuevo-agente').onclick = () => overlayFicha(true);
    $('list-inbox').onclick = () => overlayBandeja();
    $('list-actions').onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'ficha') overlayFicha(false);
      if (act === 'bandeja') overlayBandeja();
      if (act === 'nuevo') nuevoChat();
    };
    $('thread-actions').onclick = (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (act === 'fijar') alternarFijado();
      if (act === 'pase') abrirPase(false);
      if (act === 'archivar') alternarArchivado();
    };
    $('thread-head').ondblclick = (e) => {
      if (e.target.closest('#thread-actions')) return;
      renombrarChat();
    };

    // Filtros por escritura directa en raíl y lista
    $('rail').addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.length !== 1) return;
      const f = $('rail-filter');
      f.hidden = false;
      f.focus();
    });
    $('rail-filter').addEventListener('input', () => { S.filtroRail = $('rail-filter').value; pintarRail(); });
    $('rail-filter').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); $('rail-filter').value = ''; S.filtroRail = ''; $('rail-filter').hidden = true; pintarRail(); $('composer').focus(); }
    });
    $('list').addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key.length !== 1) return;
      const f = $('list-filter');
      f.hidden = false;
      f.focus();
    });
    $('list-filter').addEventListener('input', () => { S.filtroLista = $('list-filter').value; pintarLista(); });
    $('list-filter').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); $('list-filter').value = ''; S.filtroLista = ''; $('list-filter').hidden = true; pintarLista(); $('composer').focus(); }
    });

    $('overlay').addEventListener('mousedown', (e) => {
      if (e.target === $('overlay')) { S.resaltar = null; cerrarOverlay(); pintarHilo(); }
    });

    // Copia al cerrar + guardado del borrador
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        guardarBorrador();
        guardarUI();
        copiaAutomatica('cierre');
      }
    });
    window.addEventListener('pagehide', () => { guardarBorrador(); guardarUI(); });

    window.addEventListener('fluens:bd-cerrada', () => {
      aviso('otra ventana está migrando la base — recarga cuando termine', true);
      S.soloLectura = true;
      pintarEstado();
    });

    window.addEventListener('error', (e) => F.errores.registrar('window', e.message, e.filename + ':' + e.lineno));
    window.addEventListener('unhandledrejection', (e) => F.errores.registrar('promesa', e.reason, ''));

    setInterval(pintarEstado, 60000);
  }

  /* ---------------------------------------------------------------- INICIO */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
