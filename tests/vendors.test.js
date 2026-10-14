'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var core = require('../assets/js/studies-core');
var vendors = require('../assets/js/vendors-core');
var save = require('../api/save');
var upload = require('../api/upload');
var sessions = require('../api/_lib/session');
var { readJson, response, request, authenticatedCookie, githubResponse } = require('./helpers');

function vendor(overrides) {
  return Object.assign({ id: 'vendor-prueba', nombre: 'Vendor de prueba', descripcion: 'Descripción breve', categoria: '', link: '', imagen: null }, overrides);
}

// Exercise the real serverless handler; all GitHub requests are intercepted.
async function mockSave(payload, previous, options) {
  options = options || {};
  var originalFetch = global.fetch;
  var calls = [];
  var blobs = [];
  global.fetch = async function (url, init) {
    var method = init.method;
    var body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method: method, body: body });
    if (/\/git\/ref\/heads\/main$/.test(url)) return githubResponse({ object: { sha: options.currentSha || '1'.repeat(40) } });
    if (/\/git\/commits\//.test(url)) return githubResponse({ tree: { sha: '2'.repeat(40) } });
    var match = String(url).match(/\/contents\/(data\/[^?]+)/);
    if (match) {
      assert.ok(Object.prototype.hasOwnProperty.call(previous, match[1]), 'No debe leer otra colección: ' + match[1]);
      return githubResponse({ encoding: 'base64', content: Buffer.from(JSON.stringify(previous[match[1]])).toString('base64') });
    }
    if (/\/git\/blobs$/.test(url)) {
      blobs.push(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')));
      return githubResponse({ sha: String(blobs.length).padStart(40, 'a') });
    }
    if (/\/git\/trees$/.test(url)) return githubResponse({ sha: '3'.repeat(40) });
    if (/\/git\/commits$/.test(url)) return githubResponse({ sha: '4'.repeat(40) });
    if (/\/git\/refs\/heads\/main$/.test(url)) return githubResponse({}, options.refConflict ? 422 : 200);
    throw new Error('Solicitud no simulada: ' + url);
  };
  try {
    var res = response();
    var cookie = options.anonymous ? '' : await authenticatedCookie();
    await save(request('POST', Object.assign({ baseSha: '1'.repeat(40), uploads: [] }, payload), { cookie: cookie }), res);
    return { res: res, calls: calls, blobs: blobs, entries: (calls.find(function (call) { return /\/git\/trees$/.test(call.url); }) || { body: { tree: [] } }).body.tree };
  } finally { global.fetch = originalFetch; }
}

test('parseo de vendors: lista vacía, campos opcionales y serialización sin pérdida', function () {
  assert.deepEqual(vendors.parseVendors(fs.readFileSync(path.join(__dirname, '../data/vendors.json'), 'utf8')), []);
  var minimal = vendors.parseVendors('[{"id":"uno","nombre":" Uno ","descripcion":" Texto "}]');
  assert.deepEqual(minimal, [vendor({ id: 'uno', nombre: 'Uno', descripcion: 'Texto' })]);
  assert.deepEqual(vendors.parseVendors(JSON.stringify(minimal)), minimal);
  assert.throws(function () { vendors.parseVendors('{'); }, /JSON válido/);
  assert.throws(function () { vendors.parseVendors('{}'); }, /lista/);
});

test('vendors exige nombre, descripción, IDs únicos y longitudes limitadas', function () {
  [{ nombre: ' ' }, { descripcion: '' }, { id: '../escape' }, { nombre: 'a'.repeat(121) }, { descripcion: 'a'.repeat(301) }, { categoria: 0 }, { link: null }].forEach(function (bad) {
    assert.throws(function () { vendors.validateVendors([vendor(bad)]); });
  });
  assert.throws(function () { vendors.validateVendors([vendor(), vendor()]); }, /repetido/);
  assert.throws(function () { vendors.validateVendors(Array.from({ length: 101 }, function (_, i) { return vendor({ id: 'v-' + i }); })); }, /100/);
});

test('vendors rechaza enlaces ejecutables, credenciales y rutas de imágenes ajenas', function () {
  ['javascript:alert(1)', 'data:text/html,hi', '//evil.example', 'https://u:p@example.com', 'https://', 'https://exam\nple.com'].forEach(function (link) {
    assert.throws(function () { vendors.validateVendors([vendor({ link: link })]); }, /link/);
  });
  ['/assets/estudios/uno.webp', '/assets/colombia/uno.webp', '/assets/vendors/../uno.webp', 'data:image/svg+xml,hi', 'https://example.com/logo.png', 'blob:http://localhost/image'].forEach(function (ruta) {
    assert.throws(function () { vendors.validateVendors([vendor({ imagen: { ruta: ruta, alt: 'Logo', ajuste: 'fit' } })]); }, /ruta de imagen/);
  });
  assert.throws(function () { vendors.validateVendors([vendor({ imagen: { ruta: '/assets/vendors/uno.webp', alt: '' } })]); }, /alternativo/);
  assert.equal(vendors.validateVendors([vendor({ link: 'https://example.com/?a=1&b=2' })])[0].link, 'https://example.com/?a=1&b=2');
});

test('construcción HTML escapa todos los campos y oculta acciones sin sesión', function () {
  var item = vendor({ nombre: '<script>alert(1)</script>', descripcion: '<img src=x onerror="alert(1)">', categoria: '<b>Datos</b>', link: 'https://example.com/?q=" onclick="alert(1)' });
  var html = vendors.buildVendor(item, false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;/);
  assert.match(html, /&lt;b&gt;Datos&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<script|<img|data-edit|data-delete|href=/);
  var publicCard = vendors.buildVendor(vendor({ link: 'https://example.com/?x="&y=1', imagen: { ruta: '/assets/vendors/logo.webp', alt: 'Logo "seguro"', ajuste: 'fit' } }), false);
  assert.match(publicCard, /loading="lazy"/);
  assert.match(publicCard, /alt="Logo &quot;seguro&quot;"/);
  assert.match(publicCard, /rel="noopener noreferrer"/);
  assert.match(publicCard, /x=&quot;&amp;y=1/);
  assert.match(vendors.buildVendor(vendor(), true), /data-delete="vendor-prueba" data-scope="vendors"/);
  assert.doesNotMatch(vendors.buildVendor(vendor(), true), /data-move/);
});

test('CRUD compartido permite alta, edición y baja sin mutar estudios', function () {
  var studies = readJson('data/estudios.json');
  var before = JSON.stringify(studies);
  var first = core.createStudy([], vendor({ id: studies[0].id }));
  var second = core.createStudy(first, vendor({ id: 'otro' }));
  assert.equal(first.length, 1);
  var updated = core.updateStudy(second, 'otro', vendor({ id: 'otro', nombre: 'Editado' }));
  assert.equal(updated[1].nombre, 'Editado');
  assert.throws(function () { core.createStudy(updated, vendor({ id: 'otro' })); }, /ID ya existe/);
  assert.equal(core.deleteStudy(updated, 'otro').length, 1);
  assert.equal(JSON.stringify(studies), before);
});

test('las vistas previas blob solo se aceptan en el formulario local, nunca al publicar', function () {
  var item = vendor({ imagen: { ruta: 'blob:http://localhost/preview', alt: 'Logo', ajuste: 'fit' } });
  assert.equal(vendors.validateVendors([item], true)[0].imagen.ruta, item.imagen.ruta);
  assert.throws(function () { vendors.validateVendors([item]); }, /ruta de imagen/);
  assert.doesNotMatch(vendors.buildVendor(item, false), /<img/);
  assert.match(vendors.buildVendor(item, true), /<img/);
});

test('guardar un alta de vendor solo escribe vendors.json', async function () {
  var result = await mockSave({ vendors: [vendor()] }, { 'data/vendors.json': [] });
  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.entries.map(function (entry) { return entry.path; }), ['data/vendors.json']);
  assert.deepEqual(result.blobs, [[vendor()]]);
  assert.equal(result.calls.filter(function (call) { return /\/git\/commits$/.test(call.url); }).length, 1);
  assert.equal(result.calls.find(function (call) { return call.method === 'PATCH'; }).body.force, false);
});

test('baja de vendor elimina solo sus imágenes y conserva imágenes compartidas', async function () {
  var image = { ruta: '/assets/vendors/logo.webp', alt: 'Logo', ajuste: 'fit' };
  var old = [vendor({ imagen: image }), vendor({ id: 'otro', imagen: image })];
  var retained = await mockSave({ vendors: [old[1]] }, { 'data/vendors.json': old });
  assert.deepEqual(retained.entries.map(function (entry) { return entry.path; }), ['data/vendors.json']);
  var removed = await mockSave({ vendors: [] }, { 'data/vendors.json': old });
  assert.equal(removed.res.statusCode, 200);
  assert.deepEqual(removed.entries, [
    { path: 'data/vendors.json', mode: '100644', type: 'blob', sha: 'a'.repeat(39) + '1' },
    { path: 'assets/vendors/logo.webp', mode: '100644', type: 'blob', sha: null }
  ]);
});

test('guardar y eliminar estudios no lee ni modifica vendors', async function () {
  var old = readJson('data/estudios.json');
  var result = await mockSave({ studies: [] }, { 'data/estudios.json': old });
  assert.equal(result.res.statusCode, 200);
  assert.ok(result.entries.every(function (entry) { return entry.path === 'data/estudios.json' || entry.path.startsWith('assets/estudios/'); }));
});

test('las tres colecciones modificadas se guardan en un solo commit', async function () {
  var payload = { studies: readJson('data/estudios.json'), colombia: readJson('data/colombia.json'), vendors: [vendor()] };
  var result = await mockSave(payload, { 'data/estudios.json': payload.studies, 'data/colombia.json': payload.colombia, 'data/vendors.json': [] });
  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.entries.map(function (entry) { return entry.path; }), ['data/estudios.json', 'data/colombia.json', 'data/vendors.json']);
  assert.equal(result.calls.filter(function (call) { return /\/git\/commits$/.test(call.url); }).length, 1);
});

test('vendors usa la sesión existente y rechaza guardado anónimo o esquema inválido sin llamar GitHub', async function () {
  var anonymous = await mockSave({ vendors: [vendor()] }, {}, { anonymous: true });
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.calls.length, 0);
  for (var payload of [{ vendors: [vendor({ nombre: '' })] }, { vendors: null }, {}]) {
    var invalid = await mockSave(payload, {});
    assert.equal(invalid.res.statusCode, 400);
    assert.equal(invalid.calls.length, 0);
  }
});

test('conflictos antes de guardar y durante updateRef devuelven 409', async function () {
  var before = await mockSave({ vendors: [vendor()] }, {}, { currentSha: '9'.repeat(40) });
  assert.equal(before.res.statusCode, 409);
  assert.equal(before.calls.length, 1);
  var during = await mockSave({ vendors: [vendor()] }, { 'data/vendors.json': [] }, { refConflict: true });
  assert.equal(during.res.statusCode, 409);
  assert.equal(during.calls.filter(function (call) { return call.method === 'PATCH'; }).length, 1);
});

test('imágenes de vendors requieren un token firmado de la misma colección', async function () {
  var image = { ruta: '/assets/vendors/logo.webp', alt: 'Logo', ajuste: 'fit' };
  var item = vendor({ imagen: image });
  var unsigned = await mockSave({ vendors: [item] }, { 'data/vendors.json': [] });
  assert.equal(unsigned.res.statusCode, 400);
  assert.equal(unsigned.blobs.length, 0);
  var claim = { id: item.id, scope: 'vendors', path: image.ruta, sha: 'a'.repeat(40) };
  var good = await mockSave({ vendors: [item], uploads: [{ id: item.id, scope: 'vendors', token: sessions.uploadToken(claim) }] }, { 'data/vendors.json': [] });
  assert.equal(good.res.statusCode, 200);
  assert.ok(good.entries.some(function (entry) { return entry.path === 'assets/vendors/logo.webp'; }));
  for (var badClaim of [Object.assign({}, claim, { scope: 'studies' }), Object.assign({}, claim, { path: '/assets/estudios/logo.webp' }), Object.assign({}, claim, { exp: 1 })]) {
    var bad = await mockSave({ vendors: [item], uploads: [{ id: item.id, scope: 'vendors', token: sessions.uploadToken(badClaim) }] }, {});
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.calls.length, 0);
  }
});

test('la limpieza rechaza rutas de otra colección incluso si vienen del JSON anterior', async function () {
  var result = await mockSave({ vendors: [] }, { 'data/vendors.json': [vendor({ imagen: { ruta: '/assets/estudios/logo.webp', alt: 'Logo' } })] });
  assert.equal(result.res.statusCode, 400);
  assert.equal(result.entries.length, 0);
  assert.equal(result.blobs.length, 0);
});

test('/api/upload acepta vendors con la sesión compartida y firma su propia ruta', async function () {
  var originalFetch = global.fetch;
  global.fetch = async function () { return githubResponse({ sha: 'a'.repeat(40) }); };
  try {
    var image = Buffer.alloc(12);
    image.write('RIFF', 0); image.write('WEBP', 8);
    var headers = { cookie: await authenticatedCookie(), 'x-study-id': 'logo', 'x-study-scope': 'vendors' };
    var res = response();
    await upload(request('POST', image, headers), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.json.path, /^\/assets\/vendors\/logo-[a-f0-9]{12}\.webp$/);
    assert.equal(sessions.readUploadToken(res.json.token).scope, 'vendors');
    var anonymous = response();
    await upload(request('POST', image, Object.assign({}, headers, { cookie: '' })), anonymous);
    assert.equal(anonymous.statusCode, 401);
    var badScope = response();
    await upload(request('POST', image, Object.assign({}, headers, { 'x-study-scope': '__proto__' })), badScope);
    assert.equal(badScope.statusCode, 400);
  } finally { global.fetch = originalFetch; }
});
