/* Almacén de datos: datos base (datos.json) + cambios hechos en este navegador (localStorage).
   Los cambios se guardan como una "capa" encima de la base: oficinas nuevas/editadas y borradas.
   Así, si datos.json se actualiza, lo nuevo aparece igual y los cambios locales se conservan.
   Con doble clic (file://) el navegador no deja leer un .json por su cuenta: lo lee carpeta.js desde la carpeta
   conectada. Mientras tanto se muestra la última copia leída, que queda guardada en este navegador. */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var CLAVE = 'impresoras.cambios.v1';
  var CLAVE_BASE = 'impresoras.base.v1';        // última copia de los datos base (PC: de datos.json; celu: los que mandó la PC)
  var CLAVE_ENVIADO = 'impresoras.enviado.v1';  // celu: cómo estaba cada cambio cuando se pasó a la PC
  var TIPO_CAMBIOS = 'impresoras-cambios-celu';

  var base = [];
  var baseById = new Map();
  // origen: cómo estaba cada oficina en la base cuando se cambió (null = nueva). Sirve para detectar
  // si la PC también la cambió mientras tanto (ver analizarCambios y recibirDatos).
  var capa = { upserts: {}, borradas: {}, origen: {} };
  var info = { actualizado: '', ejemplo: false };
  // Copia publicada para el celular: publicar-celu.ps1 le agrega <meta name="copia" content="celu"> (las pruebas
  // usan window.COPIA_CELU). Se sabe desde que carga este archivo porque carpeta.js lo consulta al cargarse.
  var celu = esCopiaCelu();
  var memo = null;
  var escuchas = [];
  var puedeGuardar = true;

  function esCopiaCelu() {
    if (window.COPIA_CELU) return true;
    return typeof document !== 'undefined' && !!document.querySelector && !!document.querySelector('meta[name="copia"][content="celu"]');
  }

  function norm(s) { return App.Busqueda.normalizar(s); }

  function slug(s) {
    return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'oficina';
  }

  function nuevoId() {
    return 'loc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function texto(v) {
    if (v == null) return '';
    return String(v).trim();
  }

  function limpiarImpresora(p) {
    if (!p || typeof p !== 'object') return null;
    var out = {};
    Object.keys(p).forEach(function (k) {
      if (k.charAt(0) === '_') return;
      var v = p[k];
      if (v == null || typeof v === 'object') return;
      if (typeof v === 'string') { v = v.trim(); if (!v) return; }
      out[k] = v;
    });
    return Object.keys(out).length ? out : null;
  }

  function limpiarOficina(o) {
    if (!o || typeof o !== 'object') return null;
    var nombre = texto(o.nombre);
    if (!nombre) return null;
    var alias = o.alias;
    if (typeof alias === 'string') alias = alias.split(/[,;]/);
    alias = Array.isArray(alias) ? alias.map(texto).filter(Boolean) : [];

    var out = { id: texto(o.id), nombre: nombre };
    if (alias.length) out.alias = alias;
    if (texto(o.edificio)) out.edificio = texto(o.edificio);
    if (texto(o.ubicacion)) out.ubicacion = texto(o.ubicacion);
    Object.keys(o).forEach(function (k) {       // campos extra de la oficina (fuero, teléfono, etc.)
      if (k in out || k === 'impresoras' || k === 'alias' || k.charAt(0) === '_') return;
      var v = o[k];
      if (v == null || typeof v === 'object') return;
      if (typeof v === 'string') { v = v.trim(); if (!v) return; }
      out[k] = v;
    });
    out.impresoras = (Array.isArray(o.impresoras) ? o.impresoras : []).map(limpiarImpresora).filter(Boolean);
    return out;
  }

  function asignarIds(lista, usados) {
    lista.forEach(function (o) {
      var id = o.id || slug(o.nombre), cand = id, n = 2;
      while (usados.has(cand)) cand = id + '-' + (n++);
      o.id = cand;
      usados.add(cand);
    });
    return lista;
  }

  function leerRaiz(datos) {
    if (Array.isArray(datos)) return datos;
    if (datos && Array.isArray(datos.oficinas)) return datos.oficinas;
    return null;
  }

  // JSON con claves ordenadas: para comparar oficinas sin importar el orden de los campos.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  var tiene = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function compactar() {
    Object.keys(capa.upserts).forEach(function (id) {
      var b = baseById.get(id);
      if (b && canon(b) === canon(capa.upserts[id])) delete capa.upserts[id];
    });
    Object.keys(capa.borradas).forEach(function (id) {
      if (!baseById.has(id)) delete capa.borradas[id];
    });
    // Origen: se anota la primera vez que una oficina entra en la capa y se va cuando sale.
    Object.keys(capa.upserts).concat(Object.keys(capa.borradas)).forEach(function (id) {
      if (!tiene(capa.origen, id)) capa.origen[id] = baseById.get(id) || null;
    });
    Object.keys(capa.origen).forEach(function (id) {
      if (!capa.upserts[id] && !capa.borradas[id]) delete capa.origen[id];
    });
  }

  function leerCapa() {
    try {
      var raw = localStorage.getItem(CLAVE);
      if (!raw) return { upserts: {}, borradas: {}, origen: {} };
      var c = JSON.parse(raw);
      var ups = {}, ori = {};
      Object.keys((c && c.upserts) || {}).forEach(function (id) {
        var o = limpiarOficina(c.upserts[id]);
        if (o) { o.id = id; ups[id] = o; }
      });
      Object.keys((c && c.origen) || {}).forEach(function (id) {
        var o = c.origen[id] && limpiarOficina(c.origen[id]);
        if (o) o.id = id;
        ori[id] = o || null;
      });
      return { upserts: ups, borradas: (c && c.borradas) || {}, origen: ori };
    } catch (e) {
      return { upserts: {}, borradas: {}, origen: {} };
    }
  }

  function persistir() {
    memo = null;
    try {
      if (!Object.keys(capa.upserts).length && !Object.keys(capa.borradas).length) localStorage.removeItem(CLAVE);
      else localStorage.setItem(CLAVE, JSON.stringify({ v: 1, upserts: capa.upserts, borradas: capa.borradas, origen: capa.origen }));
      puedeGuardar = true;
    } catch (e) {
      puedeGuardar = false;
    }
    avisar();
    return puedeGuardar;
  }

  /* ---------- Última copia de los datos base, guardada en este navegador ---------- */
  function leerBaseGuardada() {
    try {
      var d = JSON.parse(localStorage.getItem(CLAVE_BASE) || 'null');
      return d && leerRaiz(d) ? d : null;
    } catch (e) {
      return null;
    }
  }

  function guardarBase() {
    try {
      localStorage.setItem(CLAVE_BASE, JSON.stringify({ actualizado: info.actualizado, oficinas: base }));
      return true;
    } catch (e) {
      puedeGuardar = false;
      return false;
    }
  }

  function leerEnviado() {
    try {
      var e = JSON.parse(localStorage.getItem(CLAVE_ENVIADO) || 'null');
      return e && e.firmas ? e : { fecha: '', firmas: {} };
    } catch (x) {
      return { fecha: '', firmas: {} };
    }
  }

  function guardarEnviado(e) {
    try {
      if (Object.keys(e.firmas).length) localStorage.setItem(CLAVE_ENVIADO, JSON.stringify(e));
      else localStorage.removeItem(CLAVE_ENVIADO);
    } catch (x) { /* sin espacio: a lo sumo se vuelve a ofrecer pasarlo */ }
  }

  // Cómo está ahora el cambio de una oficina ('' = sin cambio, '-' = borrada).
  function firmaCambio(id) {
    if (capa.upserts[id]) return canon(capa.upserts[id]);
    return capa.borradas[id] ? '-' : '';
  }

  function idsCambiados() {
    return Object.keys(capa.upserts).concat(Object.keys(capa.borradas).filter(function (id) { return !capa.upserts[id]; }));
  }

  function avisar() {
    escuchas.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  function init() {
    celu = esCopiaCelu();
    var d = leerBaseGuardada() || { oficinas: [] };
    info.actualizado = texto(d.actualizado);
    info.ejemplo = !!d.ejemplo;
    base = asignarIds((leerRaiz(d) || []).map(limpiarOficina).filter(Boolean), new Set());
    baseById = new Map(base.map(function (o) { return [o.id, o]; }));
    capa = leerCapa();
    compactar();

    // Si se edita en otra pestaña, refrescar esta.
    window.addEventListener('storage', function (ev) {
      if (ev.key !== CLAVE) return;
      capa = leerCapa();
      compactar();
      memo = null;
      avisar();
    });
  }

  function lista() {
    if (memo) return memo;
    var out = [];
    base.forEach(function (o) {
      if (capa.borradas[o.id]) return;
      var u = capa.upserts[o.id];
      out.push(Object.assign({}, u || o, { _origen: u ? 'editada' : 'base' }));
    });
    Object.keys(capa.upserts).forEach(function (id) {
      if (!baseById.has(id)) out.push(Object.assign({}, capa.upserts[id], { _origen: 'nueva' }));
    });
    memo = out;
    return out;
  }

  function obtener(id) {
    return lista().filter(function (o) { return o.id === id; })[0] || null;
  }

  function ponerEnCapa(oficina) {
    var o = limpiarOficina(oficina);
    if (!o) throw new Error('La oficina necesita un nombre.');
    if (!o.id) {
      var usados = new Set(lista().map(function (x) { return x.id; }));
      do { o.id = nuevoId(); } while (usados.has(o.id));
    }
    capa.upserts[o.id] = o;
    delete capa.borradas[o.id];
    return o.id;
  }

  function guardar(oficina) {
    var id = ponerEnCapa(oficina);
    compactar();
    persistir();
    return id;
  }

  // Varias oficinas de una vez (ej. asignarles un edificio): un solo aviso y un solo guardado en datos.json.
  // borrarIds (opcional): oficinas a eliminar en el mismo guardado (lo usa "Deshacer" de "Pegar datos").
  function guardarVarias(oficinas, borrarIds) {
    var ids = oficinas.map(ponerEnCapa);
    (borrarIds || []).forEach(function (id) {
      delete capa.upserts[id];
      if (baseById.has(id)) capa.borradas[id] = true;
    });
    compactar();
    persistir();
    return ids;
  }

  function eliminar(id) {
    delete capa.upserts[id];
    if (baseById.has(id)) capa.borradas[id] = true;
    compactar();
    persistir();
  }

  function foto() { return JSON.stringify(capa); }
  function volverA(f) {
    try { capa = JSON.parse(f); } catch (e) { return; }
    capa.origen = capa.origen || {};
    compactar();
    persistir();
  }

  function porNombre(nombre, excluirId) {
    var n = norm(nombre).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!n) return null;
    return lista().filter(function (o) {
      return o.id !== excluirId && norm(o.nombre).replace(/[^a-z0-9]+/g, ' ').trim() === n;
    })[0] || null;
  }

  // Oficinas que ya usan ese valor (IP, host, MAC, serie) — para avisar repetidos al cargar.
  function clave(campo, v) {
    v = texto(v).toLowerCase();
    return campo === 'mac' ? v.replace(/[^0-9a-f]/g, '') : v;
  }
  function usoDe(campo, valor, excluirId) {
    var buscado = clave(campo, valor);
    if (!buscado) return [];
    return lista().filter(function (o) {
      return o.id !== excluirId && (o.impresoras || []).some(function (p) { return clave(campo, p[campo]) === buscado; });
    });
  }

  function sinInternos(o) {
    var c = Object.assign({}, o);
    delete c._origen;
    return c;
  }

  function hoy() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function exportar() {
    return { actualizado: hoy(), oficinas: lista().map(sinInternos) };
  }

  /* ---------- Archivo datos.json: leer, escribir y fusionar ---------- */
  function lineaObjeto(o) {
    return '{ ' + Object.keys(o).map(function (k) { return JSON.stringify(k) + ': ' + JSON.stringify(o[k]); }).join(', ') + ' }';
  }

  // Formato legible: una oficina por bloque y una impresora por línea (JSON común y corriente).
  // Campos de oficina: nombre, alias, edificio, ubicacion (el piso) e impresoras. Campos de impresora: marca,
  // modelo, ip, hostname, mac, serie, sector, conexion, estado, notas (cualquier otro campo también se muestra).
  function serializar(datos) {
    if (Array.isArray(datos)) datos = { oficinas: datos };
    var ofs = (datos.oficinas || []).map(function (o) {
      var ls = Object.keys(o).filter(function (k) { return k !== 'impresoras' && k.charAt(0) !== '_'; })
        .map(function (k) { return '      ' + JSON.stringify(k) + ': ' + JSON.stringify(o[k]); });
      var ps = (o.impresoras || []).map(function (p) { return '        ' + lineaObjeto(p); });
      ls.push('      "impresoras": [' + (ps.length ? '\n' + ps.join(',\n') + '\n      ]' : ']'));
      return '    {\n' + ls.join(',\n') + '\n    }';
    });
    var cab = Object.keys(datos).filter(function (k) { return k !== 'oficinas'; })
      .map(function (k) { return '  ' + JSON.stringify(k) + ': ' + JSON.stringify(datos[k]); });
    cab.push('  "oficinas": [' + (ofs.length ? '\n' + ofs.join(',\n') + '\n  ]' : ']'));
    return '{\n' + cab.join(',\n') + '\n}\n';
  }

  // Lee datos.json (y también el datos.js de antes: "window.DATOS_IMPRESORAS = {…};", por si se trae un respaldo viejo).
  function parsearArchivo(txt) {
    txt = String(txt == null ? '' : txt).replace(/^﻿/, '');
    var m = /window\.DATOS_IMPRESORAS\s*=/.exec(txt), datos;
    if (m) {
      var desde = txt.indexOf('{', m.index), hasta = txt.lastIndexOf('}');
      if (desde === -1 || hasta < desde) throw new Error('El archivo de datos no tiene el formato esperado.');
      txt = txt.slice(desde, hasta + 1);
    }
    try { datos = JSON.parse(txt); }
    catch (e) { throw new Error('datos.json tiene un error de formato (¿se editó a mano?): ' + e.message); }
    if (Array.isArray(datos)) datos = { oficinas: datos };
    if (!leerRaiz(datos)) throw new Error('datos.json no tiene una lista de oficinas.');
    return datos;
  }

  function normalizarLista(datos) {
    return asignarIds((leerRaiz(datos) || []).map(limpiarOficina).filter(Boolean), new Set());
  }

  // Aplica los cambios de este navegador sobre lo que hay AHORA en el archivo (que puede traer
  // cambios de otra persona): así nadie pisa lo que guardó otro.
  function fusionar(datosDelArchivo) {
    var fresca = normalizarLista(datosDelArchivo), out = [], vistos = new Set();
    fresca.forEach(function (o) {
      if (capa.borradas[o.id]) return;
      out.push(capa.upserts[o.id] || o);
      vistos.add(o.id);
    });
    Object.keys(capa.upserts).forEach(function (id) {
      if (!vistos.has(id)) out.push(capa.upserts[id]);
    });
    return { actualizado: hoy(), oficinas: out };
  }

  // Reemplaza los datos base (p. ej. después de guardar o al traer cambios de otros). Los cambios
  // locales que ya quedaron en el archivo desaparecen solos al compactar; los nuevos se conservan.
  function reemplazarBase(datos) {
    var lista = normalizarLista(datos);
    info.actualizado = texto(datos.actualizado);
    info.ejemplo = !!datos.ejemplo;
    base = lista;
    baseById = new Map(base.map(function (o) { return [o.id, o]; }));
    guardarBase();
    compactar();
    persistir();
  }

  function firma(datos) { return canon(normalizarLista(datos)); }
  function firmaBase() { return canon(base); }

  // Reemplaza los datos visibles por los del archivo (queda como capa sobre la base).
  function importar(datos) {
    var raiz = leerRaiz(datos);
    if (!raiz) throw new Error('El archivo no tiene una lista de oficinas.');
    var ofs = asignarIds(raiz.map(limpiarOficina).filter(Boolean), new Set());
    if (!ofs.length) throw new Error('El archivo no tiene oficinas válidas.');
    var nueva = { upserts: {}, borradas: {}, origen: {} };
    var ids = new Set();
    ofs.forEach(function (o) { nueva.upserts[o.id] = o; ids.add(o.id); });
    base.forEach(function (o) { if (!ids.has(o.id)) nueva.borradas[o.id] = true; });
    capa = nueva;
    compactar();
    persistir();
    return ofs.length;
  }

  function restablecer() {
    capa = { upserts: {}, borradas: {}, origen: {} };
    persistir();
  }

  function cambiosLocales() {
    return Object.keys(capa.upserts).length + Object.keys(capa.borradas).length;
  }

  /* ---------- Ida y vuelta entre la PC y el celu (por archivo) ---------- */
  // Archivo de datos que llega al celu: el .json de "Pasar datos al celu" o directamente un datos.json.
  function leerArchivoDatos(txt) {
    txt = String(txt == null ? '' : txt).replace(/^﻿/, '').trim();
    var d;
    if (/window\.DATOS_IMPRESORAS\s*=/.test(txt)) d = parsearArchivo(txt);
    else {
      try { d = JSON.parse(txt); } catch (e) { throw new Error('Ese archivo no es de datos de impresoras.'); }
    }
    if (d && d.tipo === TIPO_CAMBIOS) throw new Error('Ese archivo tiene los cambios hechos en el celu: se carga en la PC (menú ⋮ → "Traer cambios del celu").');
    if (Array.isArray(d)) d = { oficinas: d };
    if (!leerRaiz(d)) throw new Error('El archivo no tiene una lista de oficinas.');
    return d;
  }

  // Archivo de cambios que llega a la PC desde el celu.
  function leerPaquete(txt) {
    var p;
    try { p = JSON.parse(String(txt == null ? '' : txt).replace(/^﻿/, '').trim()); }
    catch (e) { throw new Error('Ese archivo no es de cambios del celu.'); }
    if (p && p.tipo !== TIPO_CAMBIOS && leerRaiz(p)) throw new Error('Ese archivo tiene todos los datos (es para cargar en el celu), no los cambios hechos allá.');
    if (!p || p.tipo !== TIPO_CAMBIOS || !Array.isArray(p.cambios)) throw new Error('Ese archivo no es de cambios del celu.');
    return p;
  }

  // Celu → PC: cada oficina cambiada con cómo quedó (null = borrada) y cómo estaba antes (null = nueva).
  function paqueteCambios() {
    compactar();
    return {
      tipo: TIPO_CAMBIOS,
      v: 1,
      fecha: new Date().toISOString(),
      datosDel: info.actualizado,
      cambios: idsCambiados().map(function (id) {
        return { id: id, oficina: capa.upserts[id] || null, antes: capa.origen[id] || null };
      })
    };
  }

  // Celu: recuerda cómo estaba cada cambio al pasarlo a la PC (si después se vuelve a tocar, cuenta de nuevo).
  function marcarEnviado(p) {
    var e = { fecha: p.fecha, firmas: {} };
    p.cambios.forEach(function (c) { e.firmas[c.id] = c.oficina ? canon(c.oficina) : '-'; });
    guardarEnviado(e);
    avisar();
  }

  function enviado(id, env) {
    var f = firmaCambio(id);
    return !!f && (env || leerEnviado()).firmas[id] === f;
  }

  // Celu: cambios que todavía no se pasaron a la PC.
  function sinPasar() {
    var env = leerEnviado();
    return idsCambiados().filter(function (id) { return !enviado(id, env); }).length;
  }

  // Celu: llegan datos nuevos de la PC. Lo que el celu ya pasó a la PC y la PC tocó desde entonces se deja
  // en manos de la PC (ya lo tiene, o algo más nuevo). Lo que no se pasó todavía se conserva siempre:
  // si la PC también cambió esa oficina, se avisa acá y la PC vuelve a avisar al traer los cambios.
  function recibirDatos(datos) {
    var nuevaById = new Map(normalizarLista(datos).map(function (o) { return [o.id, o]; }));
    var env = leerEnviado(), quitados = 0, choques = [];
    idsCambiados().forEach(function (id) {
      var ahora = nuevaById.get(id) || null;
      if (canon(ahora) === canon(capa.origen[id] || null)) return;     // la PC no la tocó
      if (enviado(id, env)) {
        delete capa.upserts[id];
        delete capa.borradas[id];
        quitados++;
      } else if (canon(ahora) !== canon(capa.upserts[id] || null)) {
        choques.push((capa.upserts[id] || ahora || capa.origen[id] || { nombre: id }).nombre);
      }
    });
    reemplazarBase(datos);
    Object.keys(env.firmas).forEach(function (id) { if (!firmaCambio(id)) delete env.firmas[id]; });
    guardarEnviado(env);
    return { oficinas: base.length, quitados: quitados, choques: choques, sinPasar: sinPasar() };
  }

  // PC: qué haría cada cambio del celu. igual = ya estaba así en la PC; choque = la PC también cambió
  // esa oficina desde que el celu tomó los datos (al aplicar, queda la versión del celu).
  function analizarCambios(p) {
    var actuales = new Map(lista().map(function (o) { return [o.id, sinInternos(o)]; }));
    var conId = function (o, id) { return o && typeof o === 'object' ? limpiarOficina(Object.assign({}, o, { id: id })) : null; };
    return p.cambios.map(function (c) {
      var id = texto(c && c.id);
      if (!id) return null;
      var cel = conId(c.oficina, id);
      if (c.oficina && !cel) return null;
      var antes = conId(c.antes, id), act = actuales.get(id) || null;
      var igual = canon(act) === canon(cel);
      return {
        id: id,
        nombre: (cel || act || antes || { nombre: id }).nombre,
        tipo: !cel ? 'borrada' : act ? 'editada' : 'nueva',
        oficina: cel,
        actual: act,
        igual: igual,
        choque: !igual && canon(act) !== canon(antes)
      };
    }).filter(Boolean);
  }

  App.Almacen = {
    init: init,
    lista: lista,
    obtener: obtener,
    guardar: guardar,
    guardarVarias: guardarVarias,
    eliminar: eliminar,
    foto: foto,
    volverA: volverA,
    porNombre: porNombre,
    usoDe: usoDe,
    exportar: exportar,
    importar: importar,
    restablecer: restablecer,
    cambiosLocales: cambiosLocales,
    serializar: serializar,
    parsearArchivo: parsearArchivo,
    fusionar: fusionar,
    reemplazarBase: reemplazarBase,
    firma: firma,
    firmaBase: firmaBase,
    leerArchivoDatos: leerArchivoDatos,
    leerPaquete: leerPaquete,
    paqueteCambios: paqueteCambios,
    marcarEnviado: marcarEnviado,
    sinPasar: sinPasar,
    recibirDatos: recibirDatos,
    analizarCambios: analizarCambios,
    modoCelu: function () { return celu; },
    hayDatos: function () { return base.length > 0 || cambiosLocales() > 0; },
    info: function () { return info; },
    puedeGuardar: function () { return puedeGuardar; },
    alCambiar: function (fn) { escuchas.push(fn); }
  };
})();
