/* ============================================================================
   md.js — renderizador de Markdown SEGURO
   ----------------------------------------------------------------------------
   Regla inviolable: NUNCA se usa innerHTML con contenido del usuario.
   Todo nodo de texto se crea con document.createTextNode / textContent.

   Esto no es celo excesivo: la base entera vive en el navegador y contiene
   datos sensibles. Un fragmento pegado desde una web con un <img onerror>
   dentro sería capaz de leerla. Aquí el HTML pegado es, literalmente, texto.

   Subconjunto soportado (deliberadamente pequeño):
     ```bloque de código```   `código en línea`
     # ## ###  encabezados
     - * listas   1. listas numeradas
     > cita
     **negrita**   *cursiva*
   ========================================================================== */

(function () {
  'use strict';

  const RE_INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)/g;

  /* Pinta texto plano dentro de `destino`, resaltando `resaltar` (array de
     términos ya normalizados) si se pasa. */
  function texto(destino, txt, resaltar) {
    if (!resaltar || !resaltar.length) {
      destino.appendChild(document.createTextNode(txt));
      return;
    }
    const plano = window.Fluens.sinAcentos(txt.toLowerCase());
    const marcas = [];
    for (const term of resaltar) {
      if (!term) continue;
      let i = plano.indexOf(term);
      while (i !== -1) {
        marcas.push([i, i + term.length]);
        i = plano.indexOf(term, i + term.length);
      }
    }
    if (!marcas.length) {
      destino.appendChild(document.createTextNode(txt));
      return;
    }
    marcas.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [ini, fin] of marcas) {
      if (ini < cursor) continue;
      if (ini > cursor) destino.appendChild(document.createTextNode(txt.slice(cursor, ini)));
      const m = document.createElement('span');
      m.className = 'marca-busq';
      m.textContent = txt.slice(ini, fin);
      destino.appendChild(m);
      cursor = fin;
    }
    if (cursor < txt.length) destino.appendChild(document.createTextNode(txt.slice(cursor)));
  }

  /* Aplica los marcadores en línea sobre un fragmento de una línea. */
  function enLinea(destino, linea, resaltar) {
    let cursor = 0;
    RE_INLINE.lastIndex = 0;
    let m;
    while ((m = RE_INLINE.exec(linea)) !== null) {
      if (m.index > cursor) texto(destino, linea.slice(cursor, m.index), resaltar);
      const tok = m[0];
      let el;
      if (tok[0] === '`') {
        el = document.createElement('code');
        el.textContent = tok.slice(1, -1);
      } else if (tok.startsWith('**')) {
        el = document.createElement('strong');
        texto(el, tok.slice(2, -2), resaltar);
      } else {
        el = document.createElement('em');
        texto(el, tok.slice(1, -1), resaltar);
      }
      destino.appendChild(el);
      cursor = m.index + tok.length;
    }
    if (cursor < linea.length) texto(destino, linea.slice(cursor), resaltar);
  }

  /* Renderiza `md` dentro de un nuevo elemento y lo devuelve. */
  function render(md, resaltar) {
    const raiz = document.createElement('div');
    const lineas = String(md == null ? '' : md).split('\n');
    let i = 0;
    let parrafo = null;

    const cerrarParrafo = () => {
      if (parrafo && parrafo.childNodes.length) raiz.appendChild(parrafo);
      parrafo = null;
    };

    while (i < lineas.length) {
      const linea = lineas[i];

      // Bloque de código
      if (/^\s*```/.test(linea)) {
        cerrarParrafo();
        const buf = [];
        i++;
        while (i < lineas.length && !/^\s*```/.test(lineas[i])) { buf.push(lineas[i]); i++; }
        i++;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = buf.join('\n');
        pre.appendChild(code);
        raiz.appendChild(pre);
        continue;
      }

      // Encabezado
      const h = linea.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        cerrarParrafo();
        const el = document.createElement('h' + h[1].length);
        enLinea(el, h[2], resaltar);
        raiz.appendChild(el);
        i++;
        continue;
      }

      // Cita
      if (/^>\s?/.test(linea)) {
        cerrarParrafo();
        const buf = [];
        while (i < lineas.length && /^>\s?/.test(lineas[i])) { buf.push(lineas[i].replace(/^>\s?/, '')); i++; }
        const bq = document.createElement('blockquote');
        const p = document.createElement('p');
        enLinea(p, buf.join('\n'), resaltar);
        bq.appendChild(p);
        raiz.appendChild(bq);
        continue;
      }

      // Listas
      const esVi = /^\s*[-*]\s+/.test(linea);
      const esNu = /^\s*\d+[.)]\s+/.test(linea);
      if (esVi || esNu) {
        cerrarParrafo();
        const lista = document.createElement(esVi ? 'ul' : 'ol');
        while (i < lineas.length) {
          const l = lineas[i];
          const mm = esVi ? l.match(/^\s*[-*]\s+(.*)$/) : l.match(/^\s*\d+[.)]\s+(.*)$/);
          if (!mm) break;
          const li = document.createElement('li');
          enLinea(li, mm[1], resaltar);
          lista.appendChild(li);
          i++;
        }
        raiz.appendChild(lista);
        continue;
      }

      // Línea en blanco = fin de párrafo
      if (!linea.trim()) {
        cerrarParrafo();
        i++;
        continue;
      }

      // Párrafo (conserva los saltos de línea: white-space: pre-wrap)
      if (!parrafo) parrafo = document.createElement('p');
      else parrafo.appendChild(document.createTextNode('\n'));
      enLinea(parrafo, linea, resaltar);
      i++;
    }
    cerrarParrafo();
    return raiz;
  }

  window.FluensMD = { render, texto };
})();
