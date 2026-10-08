/* Utilidades de interfaz: íconos, avisos (toasts), modales, tema, copiar, descargar. */
(function () {
  'use strict';
  var App = window.App = window.App || {};
  var esc = App.Busqueda.esc;

  function $(sel, raiz) { return (raiz || document).querySelector(sel); }
  function $$(sel, raiz) { return Array.prototype.slice.call((raiz || document).querySelectorAll(sel)); }

  function icono(nombre, clase) {
    return '<svg class="ico' + (clase ? ' ' + clase : '') + '" aria-hidden="true"><use href="#i-' + nombre + '"/></svg>';
  }

  function movimientoReducido() {
    return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---------- Toasts ---------- */
  function toast(mensaje, opciones) {
    opciones = opciones || {};
    var tipo = opciones.tipo || 'ok';
    var dur = opciones.duracion || (opciones.accion ? 6500 : 3800);
    var ico = { ok: 'check', info: 'info', error: 'alert' }[tipo] || 'info';
    var el = document.createElement('div');
    el.className = 'toast ' + tipo;
    el.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    el.style.setProperty('--dur', dur + 'ms');
    el.innerHTML =
      '<span class="toast-ico">' + icono(ico) + '</span>' +
      '<div class="toast-msg">' + mensaje + '</div>' +
      (opciones.accion ? '<button class="toast-accion" type="button">' + esc(opciones.accion.texto) + '</button>' : '') +
      '<div class="toast-bar"></div>';
    var cont = $('#toasts');
    cont.appendChild(el);
    while (cont.children.length > 4) cont.removeChild(cont.firstChild);

    var cerrado = false;
    function cerrar() {
      if (cerrado) return;
      cerrado = true;
      el.classList.add('fuera');
      setTimeout(function () { el.remove(); }, 260);
    }
    var timer = setTimeout(cerrar, dur);
    if (opciones.accion) {
      $('.toast-accion', el).addEventListener('click', function () {
        clearTimeout(timer);
        opciones.accion.fn();
        cerrar();
      });
    }
    return { cerrar: cerrar };
  }

  /* ---------- Modales (<dialog>) con animación de salida ---------- */
  function abrirModal(dlg) {
    dlg.classList.remove('cerrando');
    if (!dlg.open) dlg.showModal();
  }

  function cerrarModal(dlg, valor) {
    if (!dlg.open || dlg.classList.contains('cerrando')) return;
    if (movimientoReducido()) { dlg.close(valor); return; }
    dlg.classList.add('cerrando');
    setTimeout(function () {
      dlg.classList.remove('cerrando');
      if (dlg.open) dlg.close(valor);
    }, 190);
  }

  // Esc y clic afuera cierran con animación.
  function prepararModal(dlg, alCancelar) {
    dlg.addEventListener('cancel', function (ev) {
      ev.preventDefault();
      if (alCancelar) alCancelar(); else cerrarModal(dlg, 'cancelar');
    });
    dlg.addEventListener('mousedown', function (ev) {
      if (ev.target === dlg) {                   // el clic cayó en el fondo (fuera de la tarjeta)
        if (alCancelar) alCancelar(); else cerrarModal(dlg, 'cancelar');
      }
    });
  }

  var dlgConf = null, resolverConf = null;
  function confirmar(op) {
    dlgConf = dlgConf || $('#modalConfirmar');
    $('#confTitulo').textContent = op.titulo || '¿Seguro?';
    $('#confTexto').innerHTML = op.texto || '';
    var ok = $('#confOk');
    ok.textContent = op.ok || 'Eliminar';
    ok.className = 'btn ' + (op.peligro === false ? 'btn-primary' : 'btn-danger');
    if (resolverConf) resolverConf(false);
    return new Promise(function (resolve) {
      resolverConf = resolve;
      abrirModal(dlgConf);
      setTimeout(function () { $('[data-resp="no"]', dlgConf).focus(); }, 30);
    });
  }
  function responderConf(v) {
    if (resolverConf) { var r = resolverConf; resolverConf = null; r(v); }
    cerrarModal(dlgConf);
  }
  function initConfirmar() {
    dlgConf = $('#modalConfirmar');
    prepararModal(dlgConf, function () { responderConf(false); });
    $$('[data-resp]', dlgConf).forEach(function (b) {
      b.addEventListener('click', function () { responderConf(b.getAttribute('data-resp') === 'si'); });
    });
  }

  /* ---------- Copiar al portapapeles ---------- */
  function copiar(txt) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return copiarViejo(txt); });
    }
    return Promise.resolve(copiarViejo(txt));
  }
  function copiarViejo(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function descargar(nombre, contenido, tipo) {
    var blob = new Blob([contenido], { type: tipo || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  /* ---------- Tema claro / oscuro ---------- */
  function temaActual() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }

  function aplicarTema(t, guardar) {
    document.documentElement.setAttribute('data-theme', t);
    if (guardar) {
      try { localStorage.setItem('impresoras.tema', t); } catch (e) { /* sin almacenamiento: solo esta sesión */ }
    }
    var b = $('#btnTema');
    if (b) {
      var txt = t === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
      b.setAttribute('aria-label', txt);
      b.title = txt;
    }
  }

  function alternarTema() {
    aplicarTema(temaActual() === 'dark' ? 'light' : 'dark', true);
  }

  /* ---------- Totales de la barra superior ---------- */
  function contarHasta(el, destino) {
    el.textContent = destino;
  }


  App.UI = {
    $: $, $$: $$, icono: icono, esc: esc,
    toast: toast,
    abrirModal: abrirModal, cerrarModal: cerrarModal, prepararModal: prepararModal,
    confirmar: confirmar, initConfirmar: initConfirmar,
    copiar: copiar, descargar: descargar,
    temaActual: temaActual, aplicarTema: aplicarTema, alternarTema: alternarTema,
    contarHasta: contarHasta, movimientoReducido: movimientoReducido
  };
})();
