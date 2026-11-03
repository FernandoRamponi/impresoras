/* Título con una luz LED que recorre el contorno de cada letra, una por una, sin parar.
   Cada palabra pasa a ser un SVG (así el título sigue acomodándose en renglones): un texto relleno
   y, encima, el mismo texto solo con trazo, cortado en un tramo corto (la luz) que avanza por el
   contorno. El navegador corta el trazo por cada letra y por cada forma de la letra (el hueco de la
   "o", el punto de la "i"…), así que cada letra lleva su propio avance y dura lo que su contorno más
   largo. Si algo falla o se pidió menos movimiento, queda el título común. */
(function () {
  'use strict';
  var App = window.App;
  var NS = 'http://www.w3.org/2000/svg';
  var TAM = 100;          // tamaño de letra dentro del SVG (unidades del viewBox = px a ese tamaño)
  var LUZ = 64;           // largo del tramo de luz
  var VEL = 0.2;          // unidades por milisegundo (≈2 segundos por letra)
  var animaciones = [], corriendo = false, siguiente = null;

  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  // Largo del contorno más largo de la letra, medido en píxeles: se dibuja en un canvas, se marcan los
  // píxeles del borde y se separan en formas (borde de afuera, huecos, puntos). Se queda con la mayor.
  function contornoMayor(ch, fuente) {
    var W = 220, H = 220, c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d', { willReadFrequently: true });
    x.font = fuente;
    x.fillText(ch, 50, 160);
    var d = x.getImageData(0, 0, W, H).data;
    var lleno = function (i, j) { return i >= 0 && j >= 0 && i < W && j < H && d[(j * W + i) * 4 + 3] > 110; };
    var borde = new Uint8Array(W * H);
    for (var j = 0; j < H; j++) {
      for (var i = 0; i < W; i++) {
        if (lleno(i, j) && (!lleno(i - 1, j) || !lleno(i + 1, j) || !lleno(i, j - 1) || !lleno(i, j + 1))) borde[j * W + i] = 1;
      }
    }
    var mayor = 0, pila = [];
    for (var k = 0; k < W * H; k++) {
      if (borde[k] !== 1) continue;
      var n = 0;
      borde[k] = 2;
      pila.push(k);
      while (pila.length) {
        var p = pila.pop(), pi = p % W, pj = (p - pi) / W;
        n++;
        for (var dj = -1; dj <= 1; dj++) {
          for (var di = -1; di <= 1; di++) {
            var qi = pi + di, qj = pj + dj, q = qj * W + qi;
            if (qi >= 0 && qj >= 0 && qi < W && qj < H && borde[q] === 1) { borde[q] = 2; pila.push(q); }
          }
        }
      }
      if (n > mayor) mayor = n;
    }
    return Math.max(40, mayor * 1.12);   // el conteo de píxeles se queda corto en las diagonales
  }

  function palabraSvg(palabra) {
    var svg = el('svg', { 'class': 'tl-palabra', 'aria-hidden': 'true', focusable: 'false' });
    var relleno = el('text', { 'class': 'tl-relleno', x: 0, y: 0 });
    var luz = el('text', { 'class': 'tl-luz', x: 0, y: 0 });
    var letras = [];
    Array.from(palabra).forEach(function (ch) {
      relleno.appendChild(document.createTextNode(ch));
      var sp = el('tspan');
      sp.textContent = ch;
      luz.appendChild(sp);
      letras.push({ ch: ch, el: sp });
    });
    svg.appendChild(relleno);
    svg.appendChild(luz);
    return { svg: svg, relleno: relleno, letras: letras };
  }

  function quitar() {
    corriendo = false;
    clearTimeout(siguiente);
    animaciones.slice().forEach(function (a) { a.cancel(); });
    animaciones = [];
  }

  function init() {
    var h1 = document.getElementById('titulo');
    if (!h1 || !document.createElementNS || !Element.prototype.animate) return;
    if (App.UI.movimientoReducido()) return;
    // Visto desde el celular (táctil): título común, sin la luz (era lo que más cargaba al celu). En la PC sigue.
    if (window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    var texto = h1.textContent.trim().replace(/\s+/g, ' ');
    if (!texto) return;

    try {
      // Brillo de la luz (un solo filtro para todas las palabras)
      if (!document.getElementById('tlBrillo')) {
        var defs = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
        defs.style.position = 'absolute';
        defs.innerHTML = '<defs><filter id="tlBrillo" x="-20%" y="-40%" width="140%" height="180%">' +
          '<feGaussianBlur stdDeviation="1.8" result="b"/>' +
          '<feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>';
        document.body.appendChild(defs);
      }

      var palabras = texto.split(' ').map(palabraSvg);
      var lector = document.createElement('span');
      lector.className = 'sr-only';
      lector.textContent = texto;
      h1.textContent = '';
      h1.appendChild(lector);
      palabras.forEach(function (p, i) {
        if (i) h1.appendChild(document.createTextNode(' '));
        h1.appendChild(p.svg);
      });

      // Tamaño de cada palabra según su ancho real con la fuente del título (en em: escala sola con la pantalla)
      var cs = getComputedStyle(palabras[0].relleno);
      var fuente = cs.fontWeight + ' ' + TAM + 'px ' + cs.fontFamily;
      palabras.forEach(function (p) {
        var ancho = p.relleno.getComputedTextLength(), margen = 8;
        p.svg.setAttribute('viewBox', (-margen) + ' -82 ' + (ancho + 2 * margen) + ' 104');
        p.svg.style.width = ((ancho + 2 * margen) / TAM) + 'em';
        p.svg.style.marginLeft = p.svg.style.marginRight = (-margen / TAM) + 'em';
      });

      // Recorrido: cada letra, en orden, de punta a punta; al terminar la última vuelve a la primera.
      // Hay UNA sola letra animándose por vez (las demás quedan con la luz escondida): más liviano y
      // fluido. La siguiente arranca cuando la luz de la actual empieza a salir, así no hay cortes.
      var todas = [], medidas = {};     // cada letra se mide una sola vez (se repiten mucho; en el celu pesa)
      palabras.forEach(function (p) { todas = todas.concat(p.letras); });
      todas.forEach(function (l) {
        l.largo = medidas[l.ch] || (medidas[l.ch] = contornoMayor(l.ch, fuente));
        l.el.style.strokeDasharray = LUZ + ' 100000';
        l.el.style.strokeDashoffset = String(LUZ);      // luz escondida antes del comienzo
      });
      quitar();
      corriendo = true;
      var correr = function (i) {
        if (!corriendo) return;
        var l = todas[i];
        var a = l.el.animate([{ strokeDashoffset: String(LUZ) }, { strokeDashoffset: String(-l.largo) }],
          { duration: (l.largo + LUZ) / VEL, easing: 'linear' });
        animaciones.push(a);
        a.onfinish = a.oncancel = function () { animaciones.splice(animaciones.indexOf(a), 1); };
        siguiente = setTimeout(function () { correr((i + 1) % todas.length); }, l.largo / VEL);
      };
      correr(0);
    } catch (e) {
      console.error(e);
      quitar();
      h1.textContent = texto;    // ante cualquier problema, el título común
    }
  }

  App.Titulo = { init: init };
})();
