/* Motor de búsqueda: normaliza (sin tildes/mayúsculas), puntúa y resalta. */
(function () {
  'use strict';
  var App = window.App = window.App || {};

  // Palabras de relleno: si el usuario las escribe no son obligatorias ("juzgado nro 5").
  var RELLENO = new Set(['n', 'nro', 'nros', 'num', 'numero', 'no', 'de', 'del', 'la', 'las',
    'el', 'los', 'lo', 'en', 'y', 'e', 'a', 'al', 'para', 'por']);
  var CAMPOS_OFICINA_FIJOS = new Set(['id', 'nombre', 'alias', 'ubicacion', 'impresoras']);

  function normalizar(s) {
    return String(s == null ? '' : s)
      .replace(/[°ºª]/g, ' ')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  }

  function palabras(s) {
    return normalizar(s).split(/[^a-z0-9]+/).filter(Boolean);
  }

  // Parte "m404dn" en m / 404 / dn (sirve para "N5", "PCyF5", modelos y series).
  function partes(w) {
    return w.match(/[a-z]+|[0-9]+/g) || [];
  }

  function expandir(lista) {
    var set = new Set();
    lista.forEach(function (w) {
      set.add(w);
      if (/[a-z]/.test(w) && /[0-9]/.test(w)) partes(w).forEach(function (p) { set.add(p); });
    });
    return Array.from(set);
  }

  // Abreviaturas escritas con punto ("Juz.", "Sec.") se indexan como "juz." para que "juzgado" las encuentre.
  function abreviaturas(s) {
    return normalizar(s).match(/(^|[^a-z0-9])[a-z]{2,6}\.(?=\s|$)/g) || [];
  }

  function sinCeros(n) { return n.replace(/^0+(?=\d)/, ''); }

  // Distancia de edición con transposición (para errores de tipeo tipo "juzagdo").
  function distancia(a, b) {
    var m = a.length, n = b.length;
    if (Math.abs(m - n) > 1) return 2;
    var d = [];
    for (var i = 0; i <= m; i++) { d[i] = [i]; }
    for (var j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  function tipoDe(v) {
    if (/^\d+$/.test(v)) return 'num';
    if (/^[a-z]+$/.test(v)) return 'word';
    return 'mixto';
  }

  function parsear(texto) {
    var terms = [];
    String(texto || '').trim().toLowerCase().split(/\s+/).forEach(function (raw) {
      if (!raw) return;
      if (/^\d{1,3}\.[\d.]*$/.test(raw)) {        // parece una IP (o parte): 10.0.12
        terms.push({ tipo: 'ip', valor: raw, relleno: false });
        return;
      }
      if (/^[0-9a-f]{2}([:-][0-9a-f]{2})+[:-]?$/.test(raw)) {   // parece una MAC (o parte): 00:11:22
        terms.push({ tipo: 'mac', valor: raw.replace(/-/g, ':'), relleno: false });
        return;
      }
      palabras(raw).forEach(function (v) {
        var t = { tipo: tipoDe(v), valor: v, relleno: RELLENO.has(v) };
        if (t.tipo === 'mixto') {
          t.partes = partes(v).filter(function (p) { return !RELLENO.has(p); })
            .map(function (p) { return { tipo: tipoDe(p), valor: p }; });
        }
        terms.push(t);
      });
    });
    return { texto: String(texto || '').trim(), terms: terms, vacia: terms.length === 0 };
  }

  // Puntaje de un término contra una palabra del índice: 3 exacto, 2 prefijo, 1 parcial, .5 con error de tipeo.
  // El error de tipeo solo se tolera si la palabra no existe tal cual en los datos (t.literal, ver buscar()).
  function comparar1(t, w, sinTipeo) {
    var v = t.valor;
    if (t.tipo === 'num') {
      if (/^\d+$/.test(w) && sinCeros(w) === sinCeros(v)) return 3;
      if (v.length >= 3 && w.indexOf(v) !== -1) return 1;
      return 0;
    }
    if (w === v) return 3;
    if (w.lastIndexOf(v, 0) === 0) return 2;
    if (t.tipo === 'word' && w.charAt(w.length - 1) === '.' && v.lastIndexOf(w.slice(0, -1), 0) === 0) return 1;   // abreviatura: "Juz." ≈ juzgado
    if (v.length >= 3 && w.indexOf(v) !== -1) return 1;
    if (!sinTipeo && !t.literal && t.tipo === 'word' && v.length >= 5 && /^[a-z]+$/.test(w) &&
        (distancia(v, w) <= 1 || (w.length > v.length && distancia(v, w.slice(0, v.length)) <= 1))) return 0.5;
    return 0;
  }

  function puntaje(t, lista) {
    var mejor = 0;
    for (var i = 0; i < lista.length && mejor < 3; i++) {
      var s = comparar1(t, lista[i]);
      if (s > mejor) mejor = s;
    }
    if (!mejor && t.partes && t.partes.length) {        // "n5" → busca "5"
      var todas = t.partes.every(function (p) { return puntaje(p, lista) > 0; });
      if (todas) mejor = 1.5;
    }
    return mejor;
  }

  function valoresImpresora(p) {
    var out = [];
    Object.keys(p || {}).forEach(function (k) {
      if (k === 'ip' || k === 'mac' || k.charAt(0) === '_') return;   // IP y MAC se buscan aparte
      var v = p[k];
      if (v != null && typeof v !== 'object') out.push(String(v));
    });
    return out.join(' ');
  }

  function valoresOficina(of) {
    var out = [of.ubicacion];
    Object.keys(of || {}).forEach(function (k) {
      if (CAMPOS_OFICINA_FIJOS.has(k) || k.charAt(0) === '_') return;
      var v = of[k];
      if (v != null && typeof v !== 'object') out.push(String(v));
    });
    return out.join(' ');
  }

  var cache = new WeakMap();
  function indexar(of) {
    var idx = cache.get(of);
    if (idx) return idx;
    var pal = function (s) {
      var abr = abreviaturas(s).map(function (a) { return a.replace(/^[^a-z]+/, ''); });
      return expandir(palabras(s)).concat(abr);
    };
    idx = {
      nombre: pal(of.nombre),
      alias: pal((of.alias || []).join(' ')),
      otros: pal(valoresOficina(of)),
      impresoras: (of.impresoras || []).map(function (p) {
        return {
          palabras: pal(valoresImpresora(p)),
          ip: String((p && p.ip) || '').toLowerCase(),
          mac: String((p && p.mac) || '').toLowerCase().replace(/-/g, ':')
        };
      })
    };
    cache.set(of, idx);
    return idx;
  }

  /* Devuelve null si no coincide; si coincide: { score, tier, impresorasMatch }.
     tier 1 = todos los términos están en el nombre/alias; tier 2 = coincide por otros datos. */
  // Números cortos (1-2 cifras: juzgado, piso) son ambiguos: fuera del nombre solo valen si otra
  // palabra de la búsqueda coincide en el mismo lugar ("piso 7" sí; "juzgado 1" no matchea "red-juzcyf99-1").
  function esCorto(t) { return t.tipo === 'num' && t.valor.length <= 2; }
  function esAncla(t) { return !t.relleno && !esCorto(t); }

  function evaluar(of, q) {
    if (q.vacia) return { score: 0, tier: 1, impresorasMatch: new Set() };
    var idx = indexar(of);
    var n = idx.impresoras.length;

    // 1) Dónde coincide cada término: nombre/alias, otros datos de la oficina, cada impresora.
    var ms = q.terms.map(function (t) {
      var m = { t: t, nom: 0, otros: 0, imp: [] };
      if (t.tipo === 'ip' || t.tipo === 'mac') {
        idx.impresoras.forEach(function (p, i) {
          var campo = p[t.tipo];
          m.imp[i] = !campo ? 0 : campo.lastIndexOf(t.valor, 0) === 0 ? 3 : (campo.indexOf(t.valor) !== -1 ? 2 : 0);
        });
      } else {
        m.nom = Math.max(puntaje(t, idx.nombre), puntaje(t, idx.alias));
        m.otros = puntaje(t, idx.otros);
        idx.impresoras.forEach(function (p, i) { m.imp[i] = puntaje(t, p.palabras); });
      }
      return m;
    });

    // 2) Anclaje de números cortos.
    var anclaOtros = ms.some(function (m) { return esAncla(m.t) && m.otros; });
    ms.forEach(function (m) {
      if (!esCorto(m.t)) return;
      if (!anclaOtros) m.otros = 0;
      for (var i = 0; i < n; i++) {
        if (m.imp[i] && !ms.some(function (o) { return o !== m && esAncla(o.t) && o.imp[i]; })) m.imp[i] = 0;
      }
    });

    // 3) Puntaje.
    var total = 0, requeridos = 0, enNombre = 0, rellenoOk = false;
    var pm = new Set();
    for (var k = 0; k < ms.length; k++) {
      var m = ms[k], sImp = 0, hits = [];
      for (var i = 0; i < n; i++) {
        if (m.imp[i]) { hits.push(i); if (m.imp[i] > sImp) sImp = m.imp[i]; }
      }
      var hubo = m.nom || m.otros || sImp;
      if (m.t.relleno) {
        if (hubo) { rellenoOk = true; total += 0.2 * Math.max(m.nom, m.otros, sImp); }
        continue;
      }
      requeridos++;
      if (!hubo) return null;
      total += m.nom * 3 + Math.max(m.otros, sImp);
      if (m.nom) enNombre++;
      else hits.forEach(function (i) { pm.add(i); });
    }
    if (!requeridos && !rellenoOk) return null;
    var tier = requeridos ? (enNombre === requeridos ? 1 : 2) : 1;
    return { score: total, tier: tier, impresorasMatch: pm };
  }

  var collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
  function comparar(a, b) { return collator.compare(a, b); }

  function buscar(oficinas, q) {
    // ¿La palabra aparece tal cual (o como prefijo/parte) en algún lado? Entonces no se "corrige" el tipeo.
    q.terms.forEach(function (t) {
      if (t.tipo !== 'word' || t.valor.length < 5) return;
      t.literal = oficinas.some(function (of) {
        var idx = indexar(of);
        var listas = [idx.nombre, idx.alias, idx.otros].concat(idx.impresoras.map(function (p) { return p.palabras; }));
        return listas.some(function (l) { return l.some(function (w) { return comparar1(t, w, true) > 0; }); });
      });
    });
    var res = [];
    oficinas.forEach(function (of) {
      var r = evaluar(of, q);
      if (r) { r.oficina = of; res.push(r); }
    });
    res.sort(function (a, b) {
      return (a.tier - b.tier) || (b.score - a.score) || comparar(a.oficina.nombre, b.oficina.nombre);
    });
    return res;
  }

  /* ---------- Resaltado ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Normaliza carácter por carácter guardando a qué posición original corresponde cada uno.
  function mapear(texto) {
    var out = '', map = [];
    for (var i = 0; i < texto.length; i++) {
      var ch = texto[i];
      var n = /[°ºª]/.test(ch) ? ' ' : ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      for (var j = 0; j < n.length; j++) { out += n[j]; map.push(i); }
    }
    return { out: out, map: map };
  }

  function construir(texto, rangos) {
    if (!rangos.length) return esc(texto);
    rangos.sort(function (a, b) { return a[0] - b[0]; });
    var unidos = [];
    rangos.forEach(function (r) {
      var u = unidos[unidos.length - 1];
      if (u && r[0] <= u[1]) u[1] = Math.max(u[1], r[1]);
      else unidos.push([r[0], r[1]]);
    });
    var html = '', pos = 0;
    unidos.forEach(function (r) {
      html += esc(texto.slice(pos, r[0])) + '<mark>' + esc(texto.slice(r[0], r[1])) + '</mark>';
      pos = r[1];
    });
    return html + esc(texto.slice(pos));
  }

  function resaltar(texto, q) {
    texto = String(texto == null ? '' : texto);
    if (!q || q.vacia || !texto) return esc(texto);
    var soloRelleno = q.terms.every(function (t) { return t.relleno || t.tipo === 'ip' || t.tipo === 'mac'; });
    var m = mapear(texto), out = m.out, rangos = [];
    var esAlnum = function (c) { return !!c && /[a-z0-9]/.test(c); };
    var esDigito = function (c) { return !!c && /[0-9]/.test(c); };

    var terminos = [];
    q.terms.forEach(function (t) {
      if (t.tipo === 'ip' || t.tipo === 'mac' || (t.relleno && !soloRelleno)) return;
      // "n5" se resalta entero si aparece así; si no, se resaltan sus partes ("5").
      if (t.partes && out.indexOf(t.valor) === -1) t.partes.forEach(function (p) { terminos.push(p); });
      else terminos.push(t);
    });

    terminos.forEach(function (t) {
      var v = t.valor, desde = 0, i;
      while ((i = out.indexOf(v, desde)) !== -1) {
        desde = i + 1;
        var antes = out[i - 1], fin = i + v.length, despues = out[fin];
        if (t.tipo === 'num') {
          if ((esDigito(antes) || esDigito(despues)) && v.length < 3) continue;
        } else if (esAlnum(antes) && !(esDigito(antes) && /^[a-z]/.test(v)) && v.length < 3) {
          continue;
        }
        rangos.push([m.map[i], m.map[fin - 1] + 1]);
      }
    });
    return construir(texto, rangos);
  }

  // Resaltado literal para IP y MAC (solo con términos de ese tipo).
  function resaltarLiteral(valor, q, tipo) {
    valor = String(valor == null ? '' : valor);
    if (!q || q.vacia) return esc(valor);
    var low = valor.toLowerCase(), rangos = [];
    if (tipo === 'mac') low = low.replace(/-/g, ':');
    q.terms.forEach(function (t) {
      if (t.tipo !== tipo) return;
      var i = low.indexOf(t.valor);
      if (i !== -1) rangos.push([i, i + t.valor.length]);
    });
    return construir(valor, rangos);
  }
  function resaltarIp(ip, q) { return resaltarLiteral(ip, q, 'ip'); }
  function resaltarMac(mac, q) { return resaltarLiteral(mac, q, 'mac'); }

  App.Busqueda = {
    normalizar: normalizar,
    parsear: parsear,
    evaluar: evaluar,
    buscar: buscar,
    comparar: comparar,
    resaltar: resaltar,
    resaltarIp: resaltarIp,
    resaltarMac: resaltarMac,
    esc: esc
  };
})();
