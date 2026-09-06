/* ============================================================================
   db.js — capa de datos de Fluens Orquestador
   ----------------------------------------------------------------------------
   IndexedDB, base `fluens`. Ocho almacenes.

   Nota sobre booleanos: IndexedDB no admite booleanos como clave de índice.
   Todo campo booleano que se indexa (archivado, fijado, abierto) se guarda
   como 0 | 1. Los que no se indexan pueden ser booleanos de verdad.
   ========================================================================== */

(function () {
  'use strict';

  const NOMBRE_BD = 'fluens';
  const VERSION_BD = 1;
  let bd = null;

  /* ---------------------------------------------------------------- UTILES */

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID()
      : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

  const ahora = () => Date.now();

  const sinAcentos = (s) =>
    String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
    'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function fechaCorta(ts) {
    const d = new Date(ts);
    return d.getDate() + ' ' + MESES_CORTO[d.getMonth()];
  }
  function fechaLarga(ts) {
    const d = new Date(ts);
    return d.getDate() + ' ' + MESES[d.getMonth()] + ' ' + d.getFullYear();
  }
  function hhmm(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function relativo(ts) {
    const dias = Math.floor((ahora() - ts) / 86400000);
    if (dias <= 0) return hhmm(ts);
    if (dias === 1) return 'ayer';
    if (dias < 7) return dias + ' d';
    if (dias < 365) return fechaCorta(ts);
    return new Date(ts).getFullYear() + '';
  }
  function diaClave(ts) {
    const d = new Date(ts);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  /* -------------------------------------------------------- TOKENIZACIÓN */

  const VACIAS = new Set(('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mi antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual sea poco ella estar haber estas estaba estamos algunas algo nosotros mi tu te ti tu tus ellas nosotras vosotros vosotras os mio mia mios mias tuyo tuya suyo suya nuestro nuestra vuestro vuestra esos esas mis ser son era eran fue fui han has hemos habia hacer hace hizo puede pueden podia debe deben asi aqui alli ahi ahora luego entonces aunque mientras segun cada mismo misma mismos mismas tal tan the of and to in is it for on with as at by an be this that from or are was').split(' '));

  /** Devuelve un Map token -> frecuencia. Minúsculas, sin acentos, >= 3. */
  function tokenizar(txt) {
    const out = new Map();
    if (!txt) return out;
    const limpio = sinAcentos(String(txt).toLowerCase());
    const piezas = limpio.split(/[^a-z0-9]+/);
    for (const p of piezas) {
      if (p.length < 3) continue;
      if (VACIAS.has(p)) continue;
      out.set(p, (out.get(p) || 0) + 1);
    }
    return out;
  }

  /* ------------------------------------------------------------- APERTURA */

  function abrir() {
    return new Promise((resolve, reject) => {
      if (bd) return resolve(bd);
      const req = indexedDB.open(NOMBRE_BD, VERSION_BD);

      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;

        if (!db.objectStoreNames.contains('agentes')) {
          const s = db.createObjectStore('agentes', { keyPath: 'id' });
          s.createIndex('posicion', 'posicion');
          s.createIndex('archivado', 'archivado');
        }
        if (!db.objectStoreNames.contains('chats')) {
          const s = db.createObjectStore('chats', { keyPath: 'id' });
          s.createIndex('agente_act', ['agenteId', 'actualizado']);
          s.createIndex('agente_fij', ['agenteId', 'fijado', 'actualizado']);
          s.createIndex('actualizado', 'actualizado');
          s.createIndex('agente_arch', ['agenteId', 'archivado']);
        }
        if (!db.objectStoreNames.contains('mensajes')) {
          const s = db.createObjectStore('mensajes', { keyPath: 'id' });
          s.createIndex('chat_orden', ['chatId', 'orden']);
          s.createIndex('agente_creado', ['agenteId', 'creado']);
          s.createIndex('agente_abierto', ['agenteId', 'abierto']);
          s.createIndex('paseId', 'paseId');
          s.createIndex('estado', 'estado');
        }
        if (!db.objectStoreNames.contains('pases')) {
          const s = db.createObjectStore('pases', { keyPath: 'id' });
          s.createIndex('bandeja', ['destinoAgenteId', 'estado', 'creado']);
          s.createIndex('origen', ['origenAgenteId', 'creado']);
          s.createIndex('par', ['origenAgenteId', 'destinoAgenteId', 'creado']);
          s.createIndex('raizId', 'raizId');
        }
        if (!db.objectStoreNames.contains('indice')) {
          // Un registro POR PAR (token, mensajeId). Nunca arrays de ids:
          // reescribir arrays de decenas de miles de ids en cada envío
          // estrangula el tecleo antes del primer año.
          const s = db.createObjectStore('indice', { keyPath: ['token', 'mensajeId'] });
          s.createIndex('mensajeId', 'mensajeId');
          s.createIndex('token_agente', ['token', 'agenteId']);
        }
        if (!db.objectStoreNames.contains('estado')) {
          db.createObjectStore('estado', { keyPath: 'clave' });
        }
        if (!db.objectStoreNames.contains('errores')) {
          db.createObjectStore('errores', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('copias')) {
          db.createObjectStore('copias', { keyPath: 'id', autoIncrement: true });
        }
      };

      req.onsuccess = () => {
        bd = req.result;
        // Otra ventana quiere migrar el esquema: cerramos para no dejarla
        // bloqueada eternamente.
        bd.onversionchange = () => {
          try { bd.close(); } catch (_) { }
          bd = null;
          window.dispatchEvent(new CustomEvent('fluens:bd-cerrada'));
        };
        resolve(bd);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('otra ventana bloquea la migración'));
    });
  }

  /* --------------------------------------------------------- PRIMITIVAS TX */

  function tx(stores, modo) {
    return bd.transaction(stores, modo);
  }
  function pedir(req) {
    return new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  function fin(t) {
    return new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('transacción abortada'));
    });
  }
  function todos(store, indice, rango, limite) {
    return new Promise((res, rej) => {
      const fuente = indice ? store.index(indice) : store;
      const out = [];
      const req = fuente.openCursor(rango || null);
      req.onsuccess = () => {
        const c = req.result;
        if (!c || (limite && out.length >= limite)) return res(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }

  const get = (store, id) => pedir(tx([store], 'readonly').objectStore(store).get(id));
  const getTodos = (store) => todos(tx([store], 'readonly').objectStore(store));

  async function put(store, obj) {
    const t = tx([store], 'readwrite');
    t.objectStore(store).put(obj);
    await fin(t);
    return obj;
  }

  /* ---------------------------------------------------------- INDEXACIÓN */

  function indexarEn(almacen, mensaje) {
    const toks = tokenizar(mensaje.texto);
    for (const [token, tf] of toks) {
      almacen.put({
        token,
        mensajeId: mensaje.id,
        agenteId: mensaje.agenteId,
        chatId: mensaje.chatId,
        creado: mensaje.creado,
        tf
      });
    }
  }

  /* Devuelve una promesa a propósito: el cursor borra de forma ASÍNCRONA.
     Si se llamara a indexarEn sin esperar a que termine, el cursor acabaría
     borrando las entradas recién escritas y el mensaje quedaría invisible
     para la búsqueda. Hay que esperar SIEMPRE antes de reindexar. */
  function desindexarEn(almacen, mensajeId) {
    return new Promise((res, rej) => {
      const req = almacen.index('mensajeId').openCursor(IDBKeyRange.only(mensajeId));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return res();
        c.delete();
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }

  /* -------------------------------------------------------------- AGENTES */

  const agentes = {
    async listar(incluirArchivados) {
      const lista = await getTodos('agentes');
      return lista
        .filter(a => incluirArchivados || !a.archivado)
        .sort((a, b) => a.posicion - b.posicion || a.creado - b.creado);
    },
    obtener: (id) => get('agentes', id),
    async crear(datos) {
      const lista = await agentes.listar(true);
      let pos = datos.posicion;
      if (!pos || lista.some(a => a.posicion === pos)) {
        pos = 1;
        while (lista.some(a => a.posicion === pos)) pos++;
      }
      const a = {
        id: uid(),
        nombre: (datos.nombre || 'Agente').trim(),
        glifo: (datos.glifo || datos.nombre || 'AG').trim().slice(0, 2).toUpperCase(),
        posicion: pos,
        proposito: datos.proposito || '',
        instruccionBase: datos.instruccionBase || '',
        permitePaseAutomatico: !!datos.permitePaseAutomatico,
        esMemoria: !!datos.esMemoria,
        // Nace NO alcanzable. Inclusión por acto, nunca por omisión: un agente
        // nuevo no hereda visibilidad de nada.
        alcanzablePorMemoria: false,
        fijo: !!datos.fijo,
        ultimoChatId: null,
        creado: ahora(),
        archivado: 0,
        version: 1
      };
      await put('agentes', a);
      return a;
    },
    guardar: (a) => put('agentes', a),
    /** Borra el agente. `destinoId` mueve sus chats; si es null, los borra. */
    async borrar(id, destinoId) {
      const chatsDel = await todos(
        tx(['chats'], 'readonly').objectStore('chats'),
        'agente_act',
        IDBKeyRange.bound([id, 0], [id, Infinity])
      );
      if (destinoId) {
        for (const c of chatsDel) await chats.moverAgente(c.id, destinoId);
      } else {
        for (const c of chatsDel) await chats.borrar(c.id);
      }
      // Los pases conservan su instantánea y quedan marcados huérfanos.
      const t = tx(['pases', 'agentes'], 'readwrite');
      const sp = t.objectStore('pases');
      await new Promise((res) => {
        const req = sp.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return res();
          const p = c.value;
          if (p.origenAgenteId === id || p.destinoAgenteId === id) {
            p.estado = p.estado === 'revocado' ? 'revocado' : 'huerfano';
            c.update(p);
          }
          c.continue();
        };
        req.onerror = () => res();
      });
      t.objectStore('agentes').delete(id);
      await fin(t);
    }
  };

  /* ---------------------------------------------------------------- CHATS */

  const chats = {
    obtener: (id) => get('chats', id),

    async listarPorAgente(agenteId, incluirArchivados) {
      const lista = await todos(
        tx(['chats'], 'readonly').objectStore('chats'),
        'agente_act',
        IDBKeyRange.bound([agenteId, 0], [agenteId, Infinity])
      );
      return lista
        .filter(c => incluirArchivados || !c.archivado)
        .sort((a, b) => b.actualizado - a.actualizado);
    },

    async recientes(limite) {
      const lista = await todos(
        tx(['chats'], 'readonly').objectStore('chats'),
        'actualizado',
        null
      );
      return lista.filter(c => !c.archivado)
        .sort((a, b) => b.actualizado - a.actualizado)
        .slice(0, limite || 8);
    },

    nuevoVirtual(agenteId) {
      // No toca el disco. Solo existe cuando hay texto (borrador o mensaje).
      return {
        id: uid(),
        agenteId,
        titulo: '',
        tituloManual: false,
        creado: ahora(),
        actualizado: ahora(),
        fijado: 0,
        archivado: 0,
        borrador: '',
        borradorCursor: 0,
        previewUltimaLinea: '',
        numMensajes: 0,
        numAbiertos: 0,
        derivadoDeChatId: null,
        scroll: 0,
        virtual: true,
        version: 1
      };
    },

    async guardar(c) {
      const copia = Object.assign({}, c);
      delete copia.virtual;
      await put('chats', copia);
      return copia;
    },

    async moverAgente(chatId, agenteId) {
      const t = tx(['chats', 'mensajes', 'indice'], 'readwrite');
      const sc = t.objectStore('chats');
      const sm = t.objectStore('mensajes');
      const si = t.objectStore('indice');
      const c = await pedir(sc.get(chatId));
      if (!c) { await fin(t); return null; }
      c.agenteId = agenteId;
      c.actualizado = ahora();
      sc.put(c);
      const msgs = await todos(sm, 'chat_orden', IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]));
      for (const m of msgs) {
        m.agenteId = agenteId;
        sm.put(m);
        await desindexarEn(si, m.id);
        indexarEn(si, m);
      }
      await fin(t);
      return c;
    },

    async borrar(chatId) {
      const t = tx(['chats', 'mensajes', 'indice', 'pases'], 'readwrite');
      const sm = t.objectStore('mensajes');
      const si = t.objectStore('indice');
      const msgs = await todos(sm, 'chat_orden', IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity]));
      for (const m of msgs) {
        sm.delete(m.id);
        desindexarEn(si, m.id);
      }
      // Los pases que salieron o llegaron aquí conservan su instantánea.
      const sp = t.objectStore('pases');
      await new Promise((res) => {
        const req = sp.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return res();
          const p = c.value;
          if (p.origenChatId === chatId || p.destinoChatId === chatId) {
            if (p.estado !== 'revocado') p.estado = 'huerfano';
            c.update(p);
          }
          c.continue();
        };
        req.onerror = () => res();
      });
      t.objectStore('chats').delete(chatId);
      await fin(t);
    },

    /** Título automático: 48 caracteres cortados en palabra. */
    tituloAuto(primeraLinea, creado) {
      const limpio = String(primeraLinea || '').replace(/\s+/g, ' ').trim();
      if (limpio.replace(/[^\p{L}\p{N}]/gu, '').length < 12) {
        return 'Sin título · ' + fechaCorta(creado) + ' ' + hhmm(creado);
      }
      if (limpio.length <= 48) return limpio;
      const corte = limpio.slice(0, 48);
      const esp = corte.lastIndexOf(' ');
      return (esp > 24 ? corte.slice(0, esp) : corte) + '…';
    }
  };

  /* ------------------------------------------------------------- MENSAJES */

  const mensajes = {
    listar: (chatId) => todos(
      tx(['mensajes'], 'readonly').objectStore('mensajes'),
      'chat_orden',
      IDBKeyRange.bound([chatId, -Infinity], [chatId, Infinity])
    ),

    obtener: (id) => get('mensajes', id),

    /** Crea el mensaje, actualiza el chat y escribe el índice — misma transacción.
        Nunca diferido: un cierre brusco entre guardar e indexar dejaría un
        mensaje invisible para siempre. */
    async crear(chat, datos) {
      const t = tx(['mensajes', 'chats', 'indice'], 'readwrite');
      const sm = t.objectStore('mensajes');
      const sc = t.objectStore('chats');
      const si = t.objectStore('indice');

      const previos = await todos(sm, 'chat_orden', IDBKeyRange.bound([chat.id, -Infinity], [chat.id, Infinity]));
      const m = {
        id: uid(),
        chatId: chat.id,
        agenteId: chat.agenteId,
        orden: previos.length ? previos[previos.length - 1].orden + 1 : 0,
        rol: datos.rol || 'usuario',
        texto: datos.texto || '',
        creado: ahora(),
        editado: null,
        estado: datos.estado || 'guardado',
        abierto: 0,
        paseId: datos.paseId || null,
        enContexto: datos.enContexto === undefined ? true : !!datos.enContexto,
        procedencia: datos.procedencia || null,
        ensamblaje: datos.ensamblaje || null,
        retirado: false,
        version: 1
      };
      sm.put(m);
      // Memoria NO se indexa a sí misma: evita el eco (un fragmento recuperado
      // volviendo como cita de sí mismo), que tus propias consultas falseen la
      // frecuencia documental del corpus, y el incentivo a usarla como diario.
      if (!datos.noIndexar) indexarEn(si, m);

      const c = Object.assign({}, chat);
      delete c.virtual;
      c.numMensajes = previos.length + 1;
      c.actualizado = m.creado;
      c.previewUltimaLinea = String(m.texto).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!c.titulo) c.titulo = chats.tituloAuto(String(m.texto).split('\n')[0], c.creado);
      sc.put(c);

      await fin(t);
      return { mensaje: m, chat: c };
    },

    async editar(id, texto) {
      const t = tx(['mensajes', 'indice', 'chats'], 'readwrite');
      const sm = t.objectStore('mensajes');
      const si = t.objectStore('indice');
      const m = await pedir(sm.get(id));
      if (!m) { await fin(t); return null; }
      m.texto = texto;
      m.editado = ahora();
      sm.put(m);
      await desindexarEn(si, id);
      indexarEn(si, m);
      const sc = t.objectStore('chats');
      const c = await pedir(sc.get(m.chatId));
      if (c) {
        const ult = await todos(sm, 'chat_orden', IDBKeyRange.bound([m.chatId, -Infinity], [m.chatId, Infinity]));
        const u = ult[ult.length - 1];
        if (u) c.previewUltimaLinea = String(u.texto).replace(/\s+/g, ' ').trim().slice(0, 120);
        sc.put(c);
      }
      await fin(t);
      return m;
    },

    async borrar(id) {
      const t = tx(['mensajes', 'indice', 'chats'], 'readwrite');
      const sm = t.objectStore('mensajes');
      const si = t.objectStore('indice');
      const m = await pedir(sm.get(id));
      if (!m) { await fin(t); return null; }
      sm.delete(id);
      await desindexarEn(si, id);
      const sc = t.objectStore('chats');
      const c = await pedir(sc.get(m.chatId));
      if (c) {
        const resto = (await todos(sm, 'chat_orden', IDBKeyRange.bound([m.chatId, -Infinity], [m.chatId, Infinity])))
          .filter(x => x.id !== id);
        c.numMensajes = resto.length;
        c.numAbiertos = resto.filter(x => x.abierto).length;
        const u = resto[resto.length - 1];
        c.previewUltimaLinea = u ? String(u.texto).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        sc.put(c);
      }
      await fin(t);
      return m;
    },

    async marcarAbierto(id, abierto) {
      const t = tx(['mensajes', 'chats'], 'readwrite');
      const sm = t.objectStore('mensajes');
      const m = await pedir(sm.get(id));
      if (!m) { await fin(t); return null; }
      m.abierto = abierto ? 1 : 0;
      sm.put(m);
      const sc = t.objectStore('chats');
      const c = await pedir(sc.get(m.chatId));
      if (c) {
        const lista = await todos(sm, 'chat_orden', IDBKeyRange.bound([m.chatId, -Infinity], [m.chatId, Infinity]));
        c.numAbiertos = lista.filter(x => (x.id === id ? m.abierto : x.abierto)).length;
        sc.put(c);
      }
      await fin(t);
      return m;
    },

    guardar: (m) => put('mensajes', m),

    abiertosDe: (agenteId) => todos(
      tx(['mensajes'], 'readonly').objectStore('mensajes'),
      'agente_abierto',
      IDBKeyRange.only([agenteId, 1])
    ),

    pendientes: () => todos(
      tx(['mensajes'], 'readonly').objectStore('mensajes'),
      'estado',
      IDBKeyRange.only('pendiente')
    )
  };

  /* ----------------------------------------------------------------- PASES */

  const pases = {
    obtener: (id) => get('pases', id),
    guardar: (p) => put('pases', p),
    listar: () => getTodos('pases'),

    bandeja: (agenteId) => todos(
      tx(['pases'], 'readonly').objectStore('pases'),
      'bandeja',
      IDBKeyRange.bound([agenteId, 'bandeja', 0], [agenteId, 'bandeja', Infinity])
    ),

    async contarBandejas() {
      const lista = await getTodos('pases');
      const mapa = new Map();
      for (const p of lista) {
        if (p.estado !== 'bandeja') continue;
        const e = mapa.get(p.destinoAgenteId) || { n: 0, masViejo: Infinity };
        e.n++;
        e.masViejo = Math.min(e.masViejo, p.creado);
        mapa.set(p.destinoAgenteId, e);
      }
      return mapa;
    },

    /** Un pase por destino, todos con el mismo raizId. */
    async crear(base, destinos) {
      const raizId = uid();
      const t = tx(['pases'], 'readwrite');
      const creados = [];
      for (const d of destinos) {
        const p = Object.assign({
          id: uid(),
          raizId,
          origenAgenteId: base.origenAgenteId,
          origenChatId: base.origenChatId,
          origenMensajeIds: base.origenMensajeIds || [],
          fragmento: base.fragmento || null,
          textoSnapshot: base.textoSnapshot || '',
          nota: base.nota || '',
          esperaRespuesta: !!base.esperaRespuesta,
          origenTipo: base.origenTipo || 'usuario',
          creado: ahora(),
          procesado: null,
          version: 1
        }, {
          destinoAgenteId: d.agenteId,
          destinoChatId: d.chatId || null,
          destinoMensajeId: null,
          estado: d.chatId ? 'insertado' : 'bandeja'
        });
        t.objectStore('pases').put(p);
        creados.push(p);
      }
      await fin(t);
      return creados;
    },

    /** Borra la instantánea en el destino y deja una lápida. */
    async revocar(paseId) {
      const p = await get('pases', paseId);
      if (!p) return null;
      if (p.destinoMensajeId) {
        const m = await get('mensajes', p.destinoMensajeId);
        if (m) {
          await mensajes.editar(m.id, '*pase revocado · ' + fechaCorta(ahora()) + '*');
        }
      }
      p.estado = 'revocado';
      p.textoSnapshot = '';
      p.procesado = ahora();
      await put('pases', p);
      return p;
    }
  };

  /* -------------------------------------------------------------- BÚSQUEDA */

  function parsearFecha(txt) {
    if (!txt) return null;
    const s = sinAcentos(txt.toLowerCase().trim());
    let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
    if (m) return new Date(+m[1], +m[2] - 1, m[3] ? +m[3] : 1).getTime();
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
    const idx = MESES.findIndex(x => sinAcentos(x) === s);
    if (idx >= 0) {
      const hoy = new Date();
      const anio = idx > hoy.getMonth() ? hoy.getFullYear() - 1 : hoy.getFullYear();
      return new Date(anio, idx, 1).getTime();
    }
    m = s.match(/^(\d{4})$/);
    if (m) return new Date(+m[1], 0, 1).getTime();
    return null;
  }

  /** Separa calificadores (agente:, desde:, hasta:, "frase") del texto libre. */
  function parsearConsulta(cruda) {
    const q = { agente: null, desde: null, hasta: null, frases: [], libre: '', fichas: [] };
    let resto = String(cruda || '');

    resto = resto.replace(/"([^"]+)"/g, (_, f) => {
      q.frases.push(sinAcentos(f.toLowerCase()));
      q.fichas.push('«' + f + '»');
      return ' ' + f + ' ';
    });
    resto = resto.replace(/\b(agente|desde|hasta):(\S+)/gi, (_, k, v) => {
      const clave = k.toLowerCase();
      if (clave === 'agente') { q.agente = v; q.fichas.push('agente: ' + v); }
      if (clave === 'desde') { q.desde = parsearFecha(v); q.fichas.push('desde: ' + v); }
      if (clave === 'hasta') { q.hasta = parsearFecha(v); q.fichas.push('hasta: ' + v); }
      return ' ';
    });
    q.libre = resto.trim();
    return q;
  }

  const TOPE_POSTINGS = 6000;

  async function buscar(cruda, listaAgentes, limite) {
    const q = parsearConsulta(cruda);
    const terminos = [...tokenizar(q.libre).keys()];
    const resultado = { consulta: q, terminos, items: [], truncado: false };

    let agenteId = null;
    if (q.agente) {
      const buscado = sinAcentos(q.agente.toLowerCase());
      const a = (listaAgentes || []).find(x =>
        sinAcentos(x.nombre.toLowerCase()).startsWith(buscado) ||
        sinAcentos(x.glifo.toLowerCase()) === buscado);
      if (a) agenteId = a.id;
    }

    if (!terminos.length && !q.frases.length) return resultado;

    const t = tx(['indice'], 'readonly');
    const si = t.objectStore('indice');
    let conjunto = null;

    // Los calificadores se resuelven SOBRE las postings, antes de tocar el
    // almacén de mensajes.
    for (const term of terminos.length ? terminos : []) {
      const rango = agenteId
        ? IDBKeyRange.only([term, agenteId])
        : IDBKeyRange.bound([term, ''], [term, '￿']);
      const filas = agenteId
        ? await todos(si, 'token_agente', rango, TOPE_POSTINGS)
        : await todos(si, null, rango, TOPE_POSTINGS);
      if (filas.length >= TOPE_POSTINGS) resultado.truncado = true;

      const ids = new Set();
      for (const f of filas) {
        if (q.desde && f.creado < q.desde) continue;
        if (q.hasta && f.creado > q.hasta + 86399999) continue;
        ids.add(f.mensajeId);
      }
      conjunto = conjunto === null ? ids : new Set([...conjunto].filter(x => ids.has(x)));
      if (!conjunto.size) break;
    }

    // Solo frases exactas, sin términos indexables: barrido acotado.
    if (conjunto === null && q.frases.length) {
      const rango = agenteId
        ? IDBKeyRange.bound([agenteId, q.desde || 0], [agenteId, q.hasta ? q.hasta + 86399999 : Infinity])
        : null;
      const sm = tx(['mensajes'], 'readonly').objectStore('mensajes');
      const filas = await todos(sm, agenteId ? 'agente_creado' : null, rango, 20000);
      conjunto = new Set(filas.map(m => m.id));
    }

    if (!conjunto || !conjunto.size) return resultado;

    const items = [];
    for (const id of conjunto) {
      const m = await get('mensajes', id);
      if (!m) continue;
      if (q.desde && m.creado < q.desde) continue;
      if (q.hasta && m.creado > q.hasta + 86399999) continue;
      if (q.frases.length) {
        const plano = sinAcentos(String(m.texto).toLowerCase());
        if (!q.frases.every(f => plano.includes(f))) continue;
      }
      items.push(m);
    }
    items.sort((a, b) => b.creado - a.creado);
    resultado.items = items.slice(0, limite || 200);
    return resultado;
  }

  /* ══════════════════════════════════════════════════════ MEMORIA CENTRAL

     Memoria NO almacena conocimiento: lo consulta. Cuando escribes en uno de
     sus chats, se interroga el índice invertido sobre todos los agentes
     ALCANZABLES y se ensambla un bloque de citas literales con procedencia.

     Reglas duras:
     - Los agentes nacen NO alcanzables. Marcar uno es un acto explícito.
       La asimetría de daño es absoluta: no encontrar algo se repara en un
       segundo; haber cruzado material sensible a otro dominio, nunca.
     - Memoria no se indexa a sí misma: ni eco, ni df falseada, ni incentivo
       a usarla como diario.
     - Un ensamblaje NO viaja: no se puede pasar ni fijar. Para llevar algo a
       otro agente se salta al original y se usa el Pase, que deja rastro.
     ══════════════════════════════════════════════════════════════════════ */

  const MEM = {
    MAX_FRAGMENTOS: 12,
    MAX_CARACTERES: 12000,
    MAX_POR_AGENTE: 4,
    MAX_FRAGMENTO: 1500,
    TOPE_POSTINGS: 20000,
    SUELO_PESO: 0.2,
    CORPUS_MINIMO: 500,     // por debajo, idf no significa nada: modo literal
    MEDIA_VIDA_DIAS: 180,
    TOPE_DEPOSITO: 6000,
    TOPE_REFERENCIAS: 2000
  };

  /** Entradas del depósito: `## clave · alta · rev` + cuerpo hasta la siguiente. */
  function entradasDeposito(texto) {
    const mapa = new Map();
    if (!texto) return mapa;
    const lineas = String(texto).split('\n');
    let actual = null;
    for (const l of lineas) {
      const m = l.match(/^##\s+([^\s·]+)(?:\s*·\s*alta\s+(\S+))?(?:\s*·\s*rev\s+(\S+))?\s*$/i);
      if (m) {
        actual = { clave: m[1].toLowerCase(), alta: m[2] || '', rev: m[3] || m[2] || '', cuerpo: [] };
        mapa.set(actual.clave, actual);
      } else if (actual) {
        actual.cuerpo.push(l);
      }
    }
    for (const e of mapa.values()) e.cuerpo = e.cuerpo.join('\n').trim();
    return mapa;
  }

  /** Sustituye las líneas `@memoria:clave` por el cuerpo de la entrada.
      Falla EN CERRADO: una referencia que no existe no expande nada. */
  function expandirReferencias(instruccionBase, entradas) {
    const refs = [];
    let caracteres = 0;
    const texto = String(instruccionBase || '').split('\n').map(linea => {
      const m = linea.match(/^\s*@memoria:([^\s·]+)/i);
      if (!m) return linea;
      const clave = m[1].toLowerCase();
      const e = entradas.get(clave);
      if (!e) { refs.push({ clave, ok: false }); return linea; }
      if (caracteres + e.cuerpo.length > MEM.TOPE_REFERENCIAS) {
        refs.push({ clave, ok: false, motivo: 'tope de referencias' });
        return linea;
      }
      caracteres += e.cuerpo.length;
      refs.push({ clave, ok: true, rev: e.rev });
      return e.cuerpo;
    }).join('\n');
    return { texto, referencias: refs, caracteres };
  }

  async function frecuenciaDocumental(token) {
    const st = tx(['indice'], 'readonly').objectStore('indice');
    return pedir(st.count(IDBKeyRange.bound([token, ''], [token, '￿'])));
  }

  /**
   * Construye el ensamblaje para una consulta.
   * opciones: { alcanzables:[agenteId], excluirAgentes:[], excluirMensajes:[] }
   */
  async function ensamblar(consultaTexto, opciones) {
    const o = opciones || {};
    const alcanzables = new Set(o.alcanzables || []);
    const fuera = new Set(o.excluirAgentes || []);
    const sinMensajes = new Set(o.excluirMensajes || []);

    const resumen = {
      coincidentes: 0, mensajesConsultados: 0, agentesConsultados: alcanzables.size,
      agentesNoAlcanzables: o.totalAgentes ? o.totalAgentes - alcanzables.size : 0,
      caracteresUsados: 0, caracteresVecindad: 0, consultaAcotada: false, saltos: 0
    };
    const salida = {
      consulta: consultaTexto, modo: 'ponderado', terminos: [],
      fragmentos: [], resumen, compactado: false
    };

    const consulta = tokenizar(consultaTexto);
    if (!consulta.size || !alcanzables.size) return salida;

    const total = await pedir(tx(['mensajes'], 'readonly').objectStore('mensajes').count());
    resumen.mensajesConsultados = total;
    if (!total) return salida;

    // Con un corpus pequeño, idf solo destaca erratas y nombres propios.
    if (total < MEM.CORPUS_MINIMO) salida.modo = 'literal';

    const pesos = [];
    for (const [token, tfConsulta] of consulta) {
      const df = await frecuenciaDocumental(token);
      if (!df) { salida.terminos.push({ token, df: 0, peso: 0, estado: 'sin apariciones' }); continue; }
      // Suelo de peso: ningún término que escribas se anula jamás.
      const peso = salida.modo === 'literal' ? 1 : Math.max(MEM.SUELO_PESO, Math.log(total / df));
      pesos.push({ token, df, peso, tfConsulta });
      salida.terminos.push({ token, df, peso: Math.round(peso * 100) / 100, estado: 'usado' });
    }
    if (!pesos.length) return salida;

    // Tope de lectura: se recortan primero los más frecuentes, y se declara.
    pesos.sort((a, b) => a.df - b.df);
    const usados = [];
    let acumulado = 0;
    for (const p of pesos) {
      if (acumulado + Math.min(p.df, MEM.TOPE_POSTINGS) > MEM.TOPE_POSTINGS && usados.length) {
        resumen.consultaAcotada = true;
        const t = salida.terminos.find(x => x.token === p.token);
        if (t) t.estado = 'recortado por frecuencia';
        continue;
      }
      acumulado += Math.min(p.df, MEM.TOPE_POSTINGS);
      usados.push(p);
    }

    const candidatos = new Map();
    for (const p of usados) {
      const filas = await todos(
        tx(['indice'], 'readonly').objectStore('indice'), null,
        IDBKeyRange.bound([p.token, ''], [p.token, '￿']), MEM.TOPE_POSTINGS
      );
      for (const f of filas) {
        if (!alcanzables.has(f.agenteId)) continue;   // filtro SOBRE las postings
        if (fuera.has(f.agenteId)) continue;
        if (sinMensajes.has(f.mensajeId)) continue;
        const e = candidatos.get(f.mensajeId) ||
          { agenteId: f.agenteId, chatId: f.chatId, creado: f.creado, bruto: 0, terminos: new Set() };
        e.bruto += p.peso * (f.tf / (f.tf + 1.5));
        e.terminos.add(p.token);
        candidatos.set(f.mensajeId, e);
      }
    }
    resumen.coincidentes = candidatos.size;
    if (!candidatos.size) return salida;

    // Puntuación final: cobertura de términos y recencia. Sin bonificación por
    // mensaje "abierto": sesgaría sistemáticamente hacia lo emocionalmente vivo.
    const chatsCache = new Map();
    const ahoraMs = ahora();
    const puntuados = [];
    for (const [id, e] of candidatos) {
      let chat = chatsCache.get(e.chatId);
      if (chat === undefined) { chat = await get('chats', e.chatId) || null; chatsCache.set(e.chatId, chat); }
      const cobertura = e.terminos.size / usados.length;
      const edadDias = (ahoraMs - e.creado) / 86400000;
      const recencia = salida.modo === 'literal' ? 1
        : 1 + 0.4 * Math.pow(0.5, edadDias / MEM.MEDIA_VIDA_DIAS);
      let p = e.bruto * cobertura * recencia;
      if (chat && chat.fijado) p *= 1.15;
      if (chat && chat.archivado) p *= 0.5;
      puntuados.push({ id, agenteId: e.agenteId, chatId: e.chatId, creado: e.creado, puntos: p, terminos: [...e.terminos] });
    }

    if (salida.modo === 'literal') puntuados.sort((a, b) => b.creado - a.creado);
    else puntuados.sort((a, b) => b.puntos - a.puntos);

    // Reparto POR RONDAS, no corte de los 12 mejores: así se ve el cruce entre
    // dominios en vez de doce resultados del agente dominante.
    const porAgente = new Map();
    for (const p of puntuados) {
      if (!porAgente.has(p.agenteId)) porAgente.set(p.agenteId, []);
      porAgente.get(p.agenteId).push(p);
    }
    const ordenAgentes = [...porAgente.keys()]
      .sort((a, b) => porAgente.get(b)[0].puntos - porAgente.get(a)[0].puntos);

    const elegidos = [];
    for (let ronda = 0; ronda < MEM.MAX_POR_AGENTE; ronda++) {
      for (const ag of ordenAgentes) {
        const lista = porAgente.get(ag);
        if (ronda >= lista.length) continue;
        if (elegidos.length >= MEM.MAX_FRAGMENTOS) break;
        elegidos.push(lista[ronda]);
      }
      if (elegidos.length >= MEM.MAX_FRAGMENTOS) break;
    }

    // Materializar: 12 finalistas × ventana de 3 = 36 lecturas del almacén,
    // hoy con 400 mensajes y dentro de dos años con 88.000. Esa es toda la
    // razón de ser de este diseño.
    for (const e of elegidos) {
      const m = await get('mensajes', e.id);
      if (!m || m.retirado) continue;
      let texto = String(m.texto);
      let recortado = false;
      if (texto.length > MEM.MAX_FRAGMENTO) { texto = texto.slice(0, MEM.MAX_FRAGMENTO) + '…'; recortado = true; }
      if (resumen.caracteresUsados + texto.length > MEM.MAX_CARACTERES) break;

      const chat = chatsCache.get(e.chatId);
      const hermanos = await mensajes.listar(e.chatId);
      const i = hermanos.findIndex(x => x.id === e.id);
      const vecinos = [];
      // Vecindad ±1, marcada y contada aparte: es texto que ninguna puntuación
      // juzgó, viajó por adyacencia. Con ±3 la mayoría de lo que viaja no ha
      // pasado ningún filtro.
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= hermanos.length) continue;
        const v = hermanos[j];
        if (v.rol === 'ensamblaje' || v.retirado) continue;
        const vt = String(v.texto).slice(0, 300);
        if (resumen.caracteresUsados + texto.length + resumen.caracteresVecindad + vt.length > MEM.MAX_CARACTERES) continue;
        vecinos.push({ mensajeId: v.id, texto: vt });
        resumen.caracteresVecindad += vt.length;
      }
      resumen.caracteresUsados += texto.length;
      salida.fragmentos.push({
        mensajeId: e.id, agenteId: e.agenteId, chatId: e.chatId,
        tituloChat: chat ? (chat.titulo || 'Sin título') : '(chat borrado)',
        creado: e.creado, puntuacion: Math.round(e.puntos * 100) / 100,
        terminos: e.terminos, texto, vecinos, recortado, excluido: false
      });
    }
    return salida;
  }

  const memoria = { MEM, entradasDeposito, expandirReferencias, ensamblar, frecuenciaDocumental };

  /* -------------------------------------------------- ESTADO DE INTERFAZ */

  const estado = {
    async leer() {
      const e = await get('estado', 'ui');
      return e || {
        clave: 'ui',
        agenteActivoId: null,
        ultimoChatPorAgente: {},
        scrollPorChat: {},
        listaColapsada: false,
        pilaSaltos: [],
        ultimosDosChats: [],
        dirCopia: null,
        version: 1
      };
    },
    guardar: (e) => put('estado', e)
  };

  /* -------------------------------------------------------------- ERRORES */

  const errores = {
    async registrar(tipo, mensaje, contexto) {
      try {
        const t = tx(['errores'], 'readwrite');
        t.objectStore('errores').put({
          ts: ahora(),
          tipo: String(tipo),
          mensaje: String(mensaje && mensaje.message ? mensaje.message : mensaje),
          contexto: contexto ? String(contexto) : ''
        });
        await fin(t);
      } catch (_) { /* si ni esto se puede escribir, no hay nada que hacer */ }
    },
    async listar(limite) {
      const l = await getTodos('errores');
      return l.sort((a, b) => b.ts - a.ts).slice(0, limite || 100);
    },
    async limpiar() {
      const t = tx(['errores'], 'readwrite');
      t.objectStore('errores').clear();
      await fin(t);
    }
  };

  /* ------------------------------------------- COPIAS, IMPORTAR, PURGAR */

  const ALMACENES = ['agentes', 'chats', 'mensajes', 'pases', 'indice', 'estado', 'copias', 'errores'];

  async function volcar() {
    const out = { formato: 'fluens-volcado', version: 1, ts: ahora(), datos: {} };
    for (const s of ALMACENES) {
      if (s === 'copias' || s === 'errores') continue;
      out.datos[s] = await getTodos(s);
    }
    return out;
  }

  const copias = {
    volcar,

    async listar() {
      const l = await getTodos('copias');
      return l.sort((a, b) => b.ts - a.ts);
    },

    async registrar(nombreArchivo, bytes, verificada) {
      const t = tx(['copias'], 'readwrite');
      t.objectStore('copias').put({ ts: ahora(), nombreArchivo, bytes, verificada: !!verificada });
      await fin(t);
      // Rotación del registro: 7 diarias + 4 semanales de historial.
      const l = await copias.listar();
      if (l.length > 40) {
        const t2 = tx(['copias'], 'readwrite');
        for (const c of l.slice(40)) t2.objectStore('copias').delete(c.id);
        await fin(t2);
      }
    },

    async ultima() {
      const l = await copias.listar();
      return l[0] || null;
    },

    /** Fusiona o reemplaza. Colisiones por id: gana la marca temporal mayor. */
    async importar(volcado, modo) {
      if (!volcado || volcado.formato !== 'fluens-volcado') {
        throw new Error('el archivo no es un volcado de Fluens');
      }
      const informe = { entraron: {}, omitidos: {}, faltaban: [] };
      const stores = ['agentes', 'chats', 'mensajes', 'pases', 'estado'];

      if (modo === 'reemplazar') {
        const t = tx(ALMACENES, 'readwrite');
        for (const s of ALMACENES) {
          if (s === 'copias') continue;
          t.objectStore(s).clear();
        }
        await fin(t);
      }

      for (const s of stores) {
        const filas = volcado.datos[s];
        if (!filas) { informe.faltaban.push(s); continue; }
        informe.entraron[s] = 0;
        informe.omitidos[s] = 0;
        const t = tx([s], 'readwrite');
        const st = t.objectStore(s);
        for (const fila of filas) {
          const clave = s === 'estado' ? fila.clave : fila.id;
          const existente = modo === 'reemplazar' ? null : await pedir(st.get(clave));
          const tsNuevo = fila.actualizado || fila.creado || fila.ts || 0;
          const tsViejo = existente ? (existente.actualizado || existente.creado || existente.ts || 0) : -1;
          if (existente && tsViejo >= tsNuevo) { informe.omitidos[s]++; continue; }
          st.put(fila);
          informe.entraron[s]++;
        }
        await fin(t);
      }

      // El índice se reconstruye siempre: es derivado y así no puede llegar
      // desincronizado desde un volcado antiguo.
      await mantenimiento.reconstruirIndice();
      return informe;
    }
  };

  const mantenimiento = {
    async reconstruirIndice(progreso) {
      const msgs = await getTodos('mensajes');
      const t0 = tx(['indice'], 'readwrite');
      t0.objectStore('indice').clear();
      await fin(t0);
      const LOTE = 200;
      for (let i = 0; i < msgs.length; i += LOTE) {
        const t = tx(['indice'], 'readwrite');
        const si = t.objectStore('indice');
        for (const m of msgs.slice(i, i + LOTE)) indexarEn(si, m);
        await fin(t);
        if (progreso) progreso(Math.min(i + LOTE, msgs.length), msgs.length);
      }
      return msgs.length;
    },

    /** Recalcula contadores desnormalizados contra la realidad. */
    async integridad() {
      const informe = { chatsCorregidos: 0, huerfanos: 0, indiceSobrante: 0, mensajes: 0, chats: 0 };
      const msgs = await getTodos('mensajes');
      const cs = await getTodos('chats');
      informe.mensajes = msgs.length;
      informe.chats = cs.length;

      const porChat = new Map();
      for (const m of msgs) {
        if (!porChat.has(m.chatId)) porChat.set(m.chatId, []);
        porChat.get(m.chatId).push(m);
      }

      const t = tx(['chats'], 'readwrite');
      const sc = t.objectStore('chats');
      for (const c of cs) {
        const lista = (porChat.get(c.id) || []).sort((a, b) => a.orden - b.orden);
        const n = lista.length;
        const ab = lista.filter(x => x.abierto).length;
        const u = lista[n - 1];
        const prev = u ? String(u.texto).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        if (c.numMensajes !== n || c.numAbiertos !== ab || c.previewUltimaLinea !== prev) {
          c.numMensajes = n; c.numAbiertos = ab; c.previewUltimaLinea = prev;
          sc.put(c);
          informe.chatsCorregidos++;
        }
      }
      await fin(t);

      const idsMsg = new Set(msgs.map(m => m.id));
      const idx = await getTodos('indice');
      const sobra = idx.filter(f => !idsMsg.has(f.mensajeId));
      informe.indiceSobrante = sobra.length;
      if (sobra.length) {
        const t2 = tx(['indice'], 'readwrite');
        for (const f of sobra) t2.objectStore('indice').delete([f.token, f.mensajeId]);
        await fin(t2);
      }

      const idsChat = new Set(cs.map(c => c.id));
      informe.huerfanos = msgs.filter(m => !idsChat.has(m.chatId)).length;
      return informe;
    },

    /** Busca una cadena en TODO y la elimina. Devuelve el recuento por almacén. */
    async purgar(cadena) {
      if (!cadena || cadena.length < 2) throw new Error('cadena demasiado corta');
      const objetivo = cadena;
      const cuenta = { mensajes: 0, chats: 0, pases: 0, agentes: 0, ensamblajes: 0, apariciones: 0 };
      const reindexar = [];

      const contar = (txt) => {
        if (!txt) return 0;
        return String(txt).split(objetivo).length - 1;
      };
      const quitar = (txt) => String(txt || '').split(objetivo).join('');

      // mensajes
      const msgs = await getTodos('mensajes');
      const t1 = tx(['mensajes'], 'readwrite');
      for (const m of msgs) {
        let n = contar(m.texto);
        let tocado = n > 0;

        // Un ensamblaje guarda tu consulta literal, los términos usados —ahí es
        // donde acaba un apellido—, el título del chat de origen congelado, y
        // el texto de los fragmentos y sus vecinos. Todo eso hay que barrerlo o
        // la purga miente.
        if (m.ensamblaje) {
          const e = m.ensamblaje;
          const nE = contar(e.consulta) +
            (e.terminos || []).reduce((a, t) => a + contar(t.token), 0) +
            (e.fragmentos || []).reduce((a, f) => a + contar(f.texto) + contar(f.tituloChat) +
              (f.vecinos || []).reduce((b, v) => b + contar(v.texto), 0), 0);
          if (nE) {
            e.consulta = quitar(e.consulta);
            e.terminos = (e.terminos || []).filter(t => !contar(t.token));
            for (const f of (e.fragmentos || [])) {
              f.texto = quitar(f.texto);
              f.tituloChat = quitar(f.tituloChat);
              f.vecinos = (f.vecinos || []).map(v => ({ ...v, texto: quitar(v.texto) }));
            }
            n += nE;
            tocado = true;
            cuenta.ensamblajes++;
          }
        }

        if (!tocado) continue;
        m.texto = quitar(m.texto);
        m.editado = ahora();
        t1.objectStore('mensajes').put(m);
        if (!m.ensamblaje) reindexar.push(m);
        cuenta.mensajes++; cuenta.apariciones += n;
      }
      await fin(t1);

      // chats: título, borrador, preview
      const cs = await getTodos('chats');
      const t2 = tx(['chats'], 'readwrite');
      for (const c of cs) {
        const n = contar(c.titulo) + contar(c.borrador) + contar(c.previewUltimaLinea);
        if (!n) continue;
        c.titulo = quitar(c.titulo);
        c.borrador = quitar(c.borrador);
        c.previewUltimaLinea = quitar(c.previewUltimaLinea);
        t2.objectStore('chats').put(c);
        cuenta.chats++; cuenta.apariciones += n;
      }
      await fin(t2);

      // pases: instantánea y nota (incluye copias en OTROS agentes)
      const ps = await getTodos('pases');
      const t3 = tx(['pases'], 'readwrite');
      for (const p of ps) {
        const n = contar(p.textoSnapshot) + contar(p.nota);
        if (!n) continue;
        p.textoSnapshot = quitar(p.textoSnapshot);
        p.nota = quitar(p.nota);
        t3.objectStore('pases').put(p);
        cuenta.pases++; cuenta.apariciones += n;
      }
      await fin(t3);

      // agentes: instrucción base y propósito
      const ags = await getTodos('agentes');
      const t4 = tx(['agentes'], 'readwrite');
      for (const a of ags) {
        const n = contar(a.instruccionBase) + contar(a.proposito);
        if (!n) continue;
        a.instruccionBase = quitar(a.instruccionBase);
        a.proposito = quitar(a.proposito);
        t4.objectStore('agentes').put(a);
        cuenta.agentes++; cuenta.apariciones += n;
      }
      await fin(t4);

      // índice invertido de los mensajes tocados
      if (reindexar.length) {
        const t5 = tx(['indice'], 'readwrite');
        const si = t5.objectStore('indice');
        for (const m of reindexar) { await desindexarEn(si, m.id); indexarEn(si, m); }
        await fin(t5);
      }
      return cuenta;
    },

    async cuota() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); } catch (_) { return null; }
    },

    async persistir() {
      if (!navigator.storage || !navigator.storage.persist) return false;
      try {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      } catch (_) { return false; }
    }
  };

  /* ------------------------------------------------------------- EXPORTAR */

  window.Fluens = {
    abrir, uid, ahora, sinAcentos, tokenizar,
    fechaCorta, fechaLarga, hhmm, relativo, diaClave, MESES, MESES_CORTO,
    agentes, chats, mensajes, pases, buscar, parsearConsulta, memoria,
    estado, errores, copias, mantenimiento,
    get bd() { return bd; }
  };
})();
