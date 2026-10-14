'use strict';

var http = require('./_lib/http');
var sessions = require('./_lib/session');
var github = require('./_lib/github');
var collections = require('./_lib/collections');

function imagePaths(collections) {
  var paths = new Set();
  collections.forEach(function (studies) {
    studies.forEach(function (study) {
      if (study.imagen) paths.add(study.imagen.ruta);
    });
  });
  return paths;
}

function uploadKey(scope, id) {
  return scope + ':' + id;
}

function validClaimPath(scope, path) {
  var directory = collections[scope].directory;
  return new RegExp('^/assets/' + directory + '/[a-z0-9-]+\\.(webp|png|jpe?g)$').test(path || '');
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch (error) { throw Object.assign(new Error('El archivo actual de ' + label + ' no es JSON válido.'), { status: 502 }); }
}

module.exports = async function save(req, res) {
  try {
    http.method(req, 'POST');
    http.verifyOrigin(req);
    sessions.requireSession(req);
    var body = await http.jsonBody(req, 2 * 1024 * 1024);
    if (!body || typeof body !== 'object') throw Object.assign(new Error('La solicitud no es válida.'), { status: 400 });
    if (typeof body.baseSha !== 'string' || !/^[a-f0-9]{40}$/i.test(body.baseSha)) {
      throw Object.assign(new Error('El SHA base no es válido.'), { status: 400 });
    }

    // Omitted scopes are never read, rewritten or included in image cleanup.
    var scopes = Object.keys(collections).filter(function (scope) {
      return Object.prototype.hasOwnProperty.call(body, scope);
    });
    if (!scopes.length) throw Object.assign(new Error('No hay colecciones para guardar.'), { status: 400 });
    var next = Object.create(null);
    scopes.forEach(function (scope) { next[scope] = collections[scope].validate(body[scope]); });
    var uploads = body.uploads === undefined ? [] : body.uploads;
    if (!Array.isArray(uploads) || uploads.length > scopes.reduce(function (sum, scope) { return sum + next[scope].length; }, 0)) {
      throw Object.assign(new Error('Las imágenes nuevas no son válidas.'), { status: 400 });
    }

    var uploadClaims = new Map();
    uploads.forEach(function (upload) {
      if (!upload || typeof upload.id !== 'string' || typeof upload.scope !== 'string' || typeof upload.token !== 'string' ||
          scopes.indexOf(upload.scope) === -1) {
        throw Object.assign(new Error('Una referencia de imagen no es válida.'), { status: 400 });
      }
      var claim = sessions.readUploadToken(upload.token);
      if (!claim || claim.id !== upload.id || claim.scope !== upload.scope || !/^[a-f0-9]{40}$/i.test(claim.sha || '') ||
          !validClaimPath(upload.scope, claim.path)) {
        throw Object.assign(new Error('Una referencia de imagen venció o fue alterada.'), { status: 400 });
      }
      var key = uploadKey(upload.scope, upload.id);
      if (uploadClaims.has(key)) throw Object.assign(new Error('Hay imágenes nuevas repetidas.'), { status: 400 });
      uploadClaims.set(key, claim);
    });

    uploadClaims.forEach(function (claim, key) {
      var scope = key.split(':')[0];
      var collection = next[scope];
      var study = collection.find(function (item) { return item.id === claim.id; });
      if (!study || !study.imagen) throw Object.assign(new Error('La imagen nueva no corresponde a un elemento de la colección.'), { status: 400 });
      study.imagen.ruta = claim.path;
    });

    var currentSha = await github.currentSha();
    if (currentSha !== body.baseSha) {
      return http.send(res, 409, { error: 'Alguien publicó cambios mientras editabas. Recarga la página para ver la versión nueva.' });
    }

    var results = await Promise.all([github.commit(currentSha)].concat(scopes.map(function (scope) {
      return github.file(collections[scope].path, currentSha);
    })));
    var currentCommit = results[0];
    var entries = [];
    // Validate old paths too: cleanup must stay inside each collection's directory.
    scopes.forEach(function (scope, index) {
      var previous = collections[scope].validate(parseJson(results[index + 1], scope));
      var oldPaths = imagePaths([previous]);
      var newPaths = imagePaths([next[scope]]);
      var claimedPaths = new Set(Array.from(uploadClaims.values()).filter(function (claim) {
        return claim.scope === scope;
      }).map(function (claim) { return claim.path; }));
      newPaths.forEach(function (path) {
        if (!oldPaths.has(path) && !claimedPaths.has(path)) {
          throw Object.assign(new Error('Una imagen nueva no fue generada por el servidor.'), { status: 400 });
        }
      });
      oldPaths.forEach(function (path) {
        if (!newPaths.has(path)) entries.push({ path: path.replace(/^\//, ''), mode: '100644', type: 'blob', sha: null });
      });
    });
    var blobs = await Promise.all(scopes.map(function (scope) {
      return github.blob(Buffer.from(JSON.stringify(next[scope], null, 2) + '\n', 'utf8'));
    }));
    entries = scopes.map(function (scope, index) {
      return { path: collections[scope].path, mode: '100644', type: 'blob', sha: blobs[index] };
    }).concat(entries);
    uploadClaims.forEach(function (claim) {
      entries.push({ path: claim.path.replace(/^\//, ''), mode: '100644', type: 'blob', sha: claim.sha });
    });

    var newTree = await github.tree(currentCommit.tree.sha, entries);
    var newCommit = await github.createCommit(newTree.sha, currentSha, 'Portafolio: actualiza ' + scopes.join(', ') + ' desde el editor');
    try { await github.updateRef(newCommit.sha); }
    catch (error) {
      if (error.status === 409 || error.status === 422) {
        return http.send(res, 409, { error: 'Alguien publicó cambios mientras editabas. Recarga la página para ver la versión nueva.' });
      }
      throw error;
    }
    http.send(res, 200, { sha: newCommit.sha });
  } catch (error) { http.handleError(res, error); }
};
