/* Formulario "Añadir / Editar oficina" con bloques de impresoras dinámicos. */
(function () {
  'use strict';
  var App = window.App;
  var A = App.Almacen, UI = App.UI;
  var $ = UI.$, $$ = UI.$$, icono = UI.icono, esc = UI.esc;

  // Marca: lista cerrada (hoy solo Ricoh) y elegida de antemano. Una impresora ya cargada con otra marca la conserva.
  var MARCAS = ['Ricoh'];
  var CAMPOS = [
    { k: 'marca', etq: 'Marca', opciones: MARCAS },
    { k: 'modelo', etq: 'Modelo', ph: 'Ej: P 311, MP 2554' },
    { k: 'ip', etq: 'IP', ph: 'Ej: 10.0.12.34', mono: true },
    { k: 'hostname', etq: 'Nombre de host', ph: 'Ej: red-juzcyf99-1', mono: true },
    { k: 'mac', etq: 'MAC', ph: 'Ej: 00:11:22:AA:BB:02', mono: true },
    { k: 'serie', etq: 'N° de serie', ph: 'Ej: 5873Z000002', mono: true },
    { k: 'sector', etq: 'Sector / ubicación', ph: 'Despacho, mesa de entradas…' },
    { k: 'conexion', etq: 'Conexión', ph: 'Red, USB…', lista: 'conexiones' },
    { k: 'estado', etq: 'Estado', ph: 'En uso, sin uso…', lista: 'estados' },
    { k: 'notas', etq: 'Notas', ph: 'Opcional' }
  ];
  var UNICOS = { ip: 'Esta IP', hostname: 'Este host', mac: 'Esta MAC', serie: 'Este N° de serie' };

  var dlg, form, cont;
  var editando = null;          // oficina que se edita (null = nueva)
  var originales = new Map();   // clave de bloque → impresora original (para no perder campos extra)
  var seq = 0;
  var sucio = false;
  var timerDup = null;

  function selectHtml(id, c, val) {
    var elegida = c.opciones.filter(function (o) { return o.toLowerCase() === val.toLowerCase(); })[0];
    var ops = c.opciones.slice();
    if (val && !elegida) ops.push(val);            // valor viejo fuera de la lista: se muestra para no perderlo
    var sel = elegida || val || c.opciones[0];
    return '<select id="' + id + '" data-k="' + c.k + '">' + ops.map(function (o) {
      return '<option value="' + esc(o) + '"' + (o === sel ? ' selected' : '') + '>' + esc(o) + '</option>';
    }).join('') + '</select>';
  }

  function bloqueHtml(clave, p) {
    var campos = CAMPOS.map(function (c) {
      var id = clave + '-' + c.k;
      var val = p && p[c.k] != null ? String(p[c.k]).trim() : '';
      return '<div class="field" data-campo="' + c.k + '">' +
        '<label for="' + id + '">' + c.etq + '</label>' +
        (c.opciones ? selectHtml(id, c, val)
          : '<input id="' + id + '" data-k="' + c.k + '" type="text" autocomplete="off" spellcheck="false"' +
            (c.lista ? ' list="' + c.lista + '"' : '') + (c.mono ? ' class="mono"' : '') +
            (c.k === 'ip' ? ' inputmode="decimal"' : '') +
            ' placeholder="' + esc(c.ph) + '" value="' + esc(val) + '">') +
        '</div>';
    }).join('');
    return '<div class="pform-head">' +
      '<strong><span class="pform-num">1</span>Impresora</strong>' +
      '<button type="button" class="pform-del" title="Quitar esta impresora" aria-label="Quitar esta impresora">' + icono('trash') + '</button>' +
      '</div><div class="grid-2">' + campos + '</div>';
  }

  function agregarBloque(p, enfocar) {
    var clave = 'p' + (++seq);
    var el = document.createElement('div');
    el.className = 'pform';
    el.setAttribute('data-clave', clave);
    el.innerHTML = bloqueHtml(clave, p);
    if (p) originales.set(clave, p);
    cont.appendChild(el);
    renumerar();
    if (enfocar) {
      setTimeout(function () {
        el.scrollIntoView({ block: 'nearest', behavior: UI.movimientoReducido() ? 'auto' : 'smooth' });
        $('input', el).focus();
      }, 40);
    }
    return el;
  }

  function quitarBloque(el) {
    sucio = true;
    originales.delete(el.getAttribute('data-clave'));
    el.classList.add('saliendo');
    setTimeout(function () { el.remove(); renumerar(); revisarDuplicados(); }, UI.movimientoReducido() ? 0 : 260);
  }

  function renumerar() {
    var bloques = $$('.pform:not(.saliendo)', cont);
    bloques.forEach(function (b, i) { $('.pform-num', b).textContent = i + 1; });
    $('#fCantidad').textContent = bloques.length;
  }

  // Edificios ya cargados (sin repetir por tildes o mayúsculas): se sugieren al escribir para que todos usen el mismo nombre.
  function edificiosCargados() {
    var mapa = new Map();
    A.lista().forEach(function (o) {
      var e = String(o.edificio || '').trim();
      var k = App.Busqueda.normalizar(e).replace(/[^a-z0-9]+/g, ' ').trim();   // misma clave que los botones de edificio
      if (e && !mapa.has(k)) mapa.set(k, e);
    });
    return mapa;
  }

  function abrir(oficina, nombreSugerido) {
    editando = oficina || null;
    originales.clear();
    cont.innerHTML = '';
    form.reset();
    limpiarErrores();
    $('#hintNombre').hidden = true;

    $('#modalTitulo').textContent = editando ? 'Editar oficina' : 'Añadir oficina';
    $('#modalSub').textContent = editando
      ? 'Modificá los datos o agregá / quitá impresoras.'
      : 'Cargá el juzgado u oficina y sus impresoras.';
    $('#fNombre').value = editando ? editando.nombre : (nombreSugerido || '');
    $('#fEdificio').value = editando && editando.edificio ? editando.edificio : '';
    $('#edificios').innerHTML = Array.from(edificiosCargados().values()).sort(App.Busqueda.comparar)
      .map(function (e) { return '<option value="' + esc(e) + '">'; }).join('');
    $('#fUbicacion').value = editando && editando.ubicacion ? editando.ubicacion : '';
    $('#fAlias').value = editando && editando.alias ? editando.alias.join(', ') : '';

    var ps = editando ? (editando.impresoras || []) : [];
    if (ps.length) ps.forEach(function (p) { agregarBloque(p, false); });
    else agregarBloque(null, false);

    sucio = false;
    revisarNombre();
    UI.abrirModal(dlg);
    $('.modal-body', dlg).scrollTop = 0;
    setTimeout(function () {
      var n = $('#fNombre');
      n.focus();
      if (editando) n.setSelectionRange(n.value.length, n.value.length);
    }, 60);
  }

  function intentarCerrar() {
    if (!sucio) { UI.cerrarModal(dlg); return; }
    UI.confirmar({
      titulo: '¿Descartar lo cargado?',
      texto: 'Los datos que escribiste en este formulario no se van a guardar.',
      ok: 'Descartar'
    }).then(function (si) { if (si) { sucio = false; UI.cerrarModal(dlg); } });
  }

  /* ---------- Validación y avisos ---------- */
  function limpiarErrores() {
    $$('.field.invalido', form).forEach(function (f) { f.classList.remove('invalido'); });
    $$('.pform .error', form).forEach(function (e) { e.remove(); });
    $('#errNombre').hidden = true;
  }

  function marcarError(field, msg) {
    field.classList.remove('invalido');
    void field.offsetWidth;                 // reinicia la animación de "temblor"
    field.classList.add('invalido');
    var p = $('.error', field);
    if (!p) {
      p = document.createElement('p');
      p.className = 'error';
      field.appendChild(p);
    }
    p.innerHTML = icono('alert') + '<span>' + esc(msg) + '</span>';
    p.hidden = false;
  }

  function ipValida(ip) {
    if (/^[\d.]+$/.test(ip)) {
      var o = ip.split('.');
      return o.length === 4 && o.every(function (x) { return /^\d{1,3}$/.test(x) && Number(x) <= 255; });
    }
    return /^[a-z0-9][a-z0-9._-]*$/i.test(ip);      // nombre de host
  }

  // Acepta 00:11:22:AA:BB:02, 00-11-22-AA-BB-02, 0011.22aa.bb02 o 001122AABB02; devuelve AA:BB:CC:DD:EE:FF.
  function macNormalizada(mac) {
    var hex = mac.replace(/[\s:.-]/g, '');
    if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
    return hex.toUpperCase().match(/../g).join(':');
  }

  function revisarNombre() {
    var hint = $('#hintNombre');
    var nombre = $('#fNombre').value.trim();
    var otra = nombre ? A.porNombre(nombre, editando && editando.id) : null;
    if (!otra) { hint.hidden = true; return; }
    hint.className = editando ? 'warn' : 'hint';
    hint.innerHTML = icono('info') + '<span>' + (editando
      ? 'Ya hay otra oficina con este nombre: «' + esc(otra.nombre) + '».'
      : 'Ya existe «' + esc(otra.nombre) + '». Al guardar, estas impresoras se suman a esa oficina.') + '</span>';
    hint.hidden = false;
  }

  // Avisa (sin bloquear) si una IP, host, MAC o serie ya está en otra oficina o repetida en el formulario.
  function revisarDuplicados() {
    Object.keys(UNICOS).forEach(function (campo) {
      var vistos = {};
      $$('.pform:not(.saliendo) [data-campo="' + campo + '"]', cont).forEach(function (field) {
        var v = $('input', field).value.trim().toLowerCase();
        if (campo === 'mac') v = v.replace(/[^0-9a-f]/g, '');
        var w = $('.warn', field);
        var msg = '';
        if (v) {
          var otras = A.usoDe(campo, v, editando && editando.id);
          if (vistos[v]) msg = UNICOS[campo] + ' está repetido en el formulario.';
          else if (otras.length) msg = UNICOS[campo] + ' ya figura en «' + otras[0].nombre + '».';
          vistos[v] = true;
        }
        if (!msg) { if (w) w.remove(); return; }
        if (!w) { w = document.createElement('p'); w.className = 'warn'; field.appendChild(w); }
        w.innerHTML = icono('alert') + '<span>' + esc(msg) + '</span>';
      });
    });
  }

  function leerBloques() {
    return $$('.pform:not(.saliendo)', cont).map(function (b) {
      var datos = {};
      $$('[data-k]', b).forEach(function (i) { datos[i.getAttribute('data-k')] = i.value.trim(); });
      return { el: b, clave: b.getAttribute('data-clave'), datos: datos };
    });
  }

  function guardar(ev) {
    ev.preventDefault();
    limpiarErrores();
    var ok = true;
    var nombre = $('#fNombre').value.trim().replace(/\s+/g, ' ');
    if (!nombre) {
      marcarError($('#fNombre').closest('.field'), 'Escribí el nombre de la oficina o juzgado.');
      ok = false;
    }

    var impresoras = [];
    leerBloques().forEach(function (b) {
      var d = b.datos;
      var vacio = CAMPOS.every(function (c) { return c.opciones || !d[c.k]; });   // la marca viene elegida: no cuenta
      if (vacio) return;                            // bloque vacío: se ignora
      if (!d.modelo && !d.ip && !d.hostname && !d.serie) {
        marcarError($('[data-campo="modelo"]', b.el), 'Completá al menos el modelo, la IP o el N° de serie.');
        ok = false;
      }
      // Solo se valida lo que se escribió/cambió: un dato viejo mal cargado no bloquea guardar el resto.
      var orig = originales.get(b.clave) || {};
      var igualQueAntes = function (k) { return d[k] === String(orig[k] == null ? '' : orig[k]).trim(); };
      if (d.ip && !ipValida(d.ip) && !igualQueAntes('ip')) {
        marcarError($('[data-campo="ip"]', b.el), 'IP incompleta o inválida. Ejemplo: 10.0.12.34');
        ok = false;
      }
      if (d.mac) {
        var mac = macNormalizada(d.mac);
        if (mac) d.mac = mac;
        else if (!igualQueAntes('mac')) {
          marcarError($('[data-campo="mac"]', b.el), 'MAC inválida. Ejemplo: 00:11:22:AA:BB:02');
          ok = false;
        }
      }
      // Se parte de la impresora original para conservar campos que el formulario no muestra.
      var p = Object.assign({}, originales.get(b.clave) || {});
      CAMPOS.forEach(function (c) { if (d[c.k]) p[c.k] = d[c.k]; else delete p[c.k]; });
      impresoras.push(p);
    });

    if (!ok) {
      var primero = $('.field.invalido input', form);
      if (primero) primero.focus();
      return;
    }

    var alias = $('#fAlias').value.split(/[,;]/).map(function (s) { return s.trim(); }).filter(Boolean);
    var ubicacion = $('#fUbicacion').value.trim();
    var edificio = $('#fEdificio').value.trim().replace(/\s+/g, ' ');
    var id, mensaje;

    var existente = !editando ? A.porNombre(nombre) : null;
    if (existente) {
      // Ya existía: se suman las impresoras a esa oficina en vez de duplicarla.
      var fusion = Object.assign({}, existente);
      delete fusion._origen;
      fusion.impresoras = (existente.impresoras || []).concat(impresoras);
      if (!fusion.ubicacion && ubicacion) fusion.ubicacion = ubicacion;
      if (!fusion.edificio && edificio) fusion.edificio = edificio;
      if (alias.length) {
        var previos = fusion.alias || [];
        fusion.alias = previos.concat(alias.filter(function (a) { return previos.indexOf(a) === -1; }));
      }
      id = A.guardar(fusion);
      mensaje = 'Se ' + (impresoras.length === 1 ? 'sumó 1 impresora' : 'sumaron ' + impresoras.length + ' impresoras') +
        ' a <b>' + esc(existente.nombre) + '</b>';
    } else {
      var of = Object.assign({}, editando || {});
      delete of._origen;
      of.nombre = nombre;
      of.impresoras = impresoras;
      if (ubicacion) of.ubicacion = ubicacion; else delete of.ubicacion;
      if (edificio) of.edificio = edificio; else delete of.edificio;
      if (alias.length) of.alias = alias; else delete of.alias;
      id = A.guardar(of);
      mensaje = (editando ? 'Cambios guardados en ' : 'Se añadió ') + '<b>' + esc(nombre) + '</b>';
    }

    sucio = false;
    UI.cerrarModal(dlg);
    App.mostrarOficina(id);
    if (A.puedeGuardar()) UI.toast(mensaje);
    else UI.toast('No se pudo guardar en este navegador (almacenamiento bloqueado). Exportá una copia antes de cerrar.', { tipo: 'error', duracion: 8000 });
  }

  function init() {
    dlg = $('#modalOficina');
    form = $('#formOficina');
    cont = $('#printerForms');

    UI.prepararModal(dlg, intentarCerrar);
    $$('[data-cerrar]', dlg).forEach(function (b) { b.addEventListener('click', intentarCerrar); });
    form.addEventListener('submit', guardar);
    form.addEventListener('input', function (ev) {
      sucio = true;
      var field = ev.target.closest('.field');
      if (field && field.classList.contains('invalido')) {
        field.classList.remove('invalido');
        var e = $('.error', field);
        if (e) e.hidden = true;
      }
      if (ev.target.id === 'fNombre') revisarNombre();
      if (UNICOS[ev.target.getAttribute('data-k')]) {
        clearTimeout(timerDup);
        timerDup = setTimeout(revisarDuplicados, 250);
      }
    });
    $('#btnOtraImpresora').addEventListener('click', function () { sucio = true; agregarBloque(null, true); });
    cont.addEventListener('click', function (ev) {
      var del = ev.target.closest('.pform-del');
      if (del) quitarBloque(del.closest('.pform'));
    });
  }

  App.Formulario = { init: init, abrir: abrir };
})();
