/* Service worker de la app del celu: guarda la web en el celu para que abra al instante y sin conexión.
   Responde con lo guardado y, de fondo, trae la versión nueva (se ve la próxima vez que se abre).
   Los datos NO pasan por acá: viven en el almacenamiento del celu (ver js/almacen.js) y llegan de GitHub (js/sync.js),
   que es de otro origen y el service worker no toca.
   publicar-celu.ps1 cambia VERSION en cada publicación, así el celu descarta la copia vieja. */
var VERSION = '20261008-115656';
var CACHE = 'impresoras-' + VERSION;
var ARCHIVOS = [
  './',
  'index.html',
  'estilos.css',
  'js/busqueda.js',
  'js/almacen.js',
  'js/ui.js',
  'js/formulario.js',
  'js/pegar.js',
  'js/titulo.js',
  'js/carpeta.js',
  'js/sync.js',
  'js/celu.js',
  'js/app.js',
  'manifest.webmanifest',
  'iconos/icono-192.png',
  'iconos/icono-512.png',
  'iconos/icono-maskable-512.png',
  'iconos/apple-touch-icon.png'
];

// Siempre pregunta al servidor (cache: 'no-cache'): GitHub Pages deja usar 10 min la copia del navegador y, sin esto,
// la versión nueva podía guardarse con el CSS/JS viejo.
self.addEventListener('install', function (ev) {
  ev.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ARCHIVOS.map(function (a) { return new Request(a, { cache: 'no-cache' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(caches.keys().then(function (claves) {
    return Promise.all(claves.filter(function (k) { return k.indexOf('impresoras-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (ev) {
  var req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var red = fetch(req, { cache: 'no-cache' }).then(function (r) {
    if (!r || !r.ok) return r;
    var copia = r.clone();
    return caches.open(CACHE).then(function (c) { return c.put(req, copia); }).then(function () { return r; });
  });
  ev.respondWith(caches.match(req, { ignoreSearch: true }).then(function (guardada) { return guardada || red; }));
  ev.waitUntil(red.catch(function () { /* sin conexión: queda lo guardado */ }));
});
