(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./studies-core'));
  else root.VendorsCore = factory(root.StudiesCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';

  function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }

  function text(value, label, max, required) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string') invalid(label + ' debe ser texto.');
    value = value.trim();
    if (required && !value) invalid(label + ' es obligatorio.');
    if (value.length > max) invalid(label + ' supera el máximo de ' + max + ' caracteres.');
    return value;
  }

  function safeLink(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return '';
    try {
      var url = new URL(value);
      return url.hostname && !url.username && !url.password ? value : '';
    } catch (error) { return ''; }
  }

  function safeImage(value, allowPreview) {
    return typeof value === 'string' && (/^\/assets\/vendors\/[a-z0-9-]+\.(webp|png|jpe?g)$/.test(value) ||
      (allowPreview && /^blob:https?:\/\//.test(value)));
  }

  // Shared by the browser and /api/save. Only the local form accepts blob previews.
  function validateVendors(input, allowPreview) {
    if (!Array.isArray(input) || input.length > 100) invalid('Vendors debe ser una lista de hasta 100 elementos.');
    var ids = new Set();
    return input.map(function (vendor) {
      if (!vendor || typeof vendor !== 'object' || Array.isArray(vendor)) invalid('El vendor no es válido.');
      var id = text(vendor.id, 'ID', 80, true);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) invalid('El ID solo puede tener minúsculas, números y guiones.');
      if (ids.has(id)) invalid('El ID ' + id + ' está repetido.');
      ids.add(id);
      var link = text(vendor.link, 'Link', 2048, false);
      if (link && !safeLink(link)) invalid('El link debe ser una URL http o https válida, sin credenciales.');
      var image = null;
      if (vendor.imagen != null) {
        if (typeof vendor.imagen !== 'object' || Array.isArray(vendor.imagen)) invalid('La imagen no es válida.');
        var route = text(vendor.imagen.ruta, 'Ruta de imagen', 240, true);
        if (!safeImage(route, allowPreview)) invalid('La ruta de imagen del vendor no es válida.');
        var fit = vendor.imagen.ajuste || 'fit';
        if (fit !== 'fit' && fit !== 'cover') invalid('El ajuste de imagen no es válido.');
        image = { ruta: route, alt: text(vendor.imagen.alt, 'Texto alternativo', 250, true), ajuste: fit };
      }
      return {
        id: id,
        nombre: text(vendor.nombre, 'Nombre', 120, true),
        descripcion: text(vendor.descripcion, 'Descripción corta', 300, true),
        categoria: text(vendor.categoria, 'Categoría', 120, false),
        link: link,
        imagen: image
      };
    });
  }

  function parseVendors(source) {
    var data;
    try { data = JSON.parse(source); }
    catch (error) { invalid('El archivo de vendors no es JSON válido.'); }
    return validateVendors(data);
  }

  function buildVendor(vendor, editing) {
    var esc = core.esc;
    var html = '<article class="vendor-card" id="vendor-' + esc(vendor.id) + '">';
    if (vendor.imagen && safeImage(vendor.imagen.ruta, editing)) {
      html += '<figure class="vendor-image' + (vendor.imagen.ajuste === 'cover' ? ' cover' : '') + '"><img src="' + esc(vendor.imagen.ruta) + '" alt="' + esc(vendor.imagen.alt) + '" loading="lazy" decoding="async" width="320" height="160"></figure>';
    }
    if (vendor.categoria) html += '<span class="vendor-category">' + esc(vendor.categoria) + '</span>';
    html += '<h3>' + esc(vendor.nombre) + '</h3><p>' + esc(vendor.descripcion) + '</p>';
    var link = safeLink(vendor.link);
    if (link) html += '<a class="vendor-link" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Visitar sitio<span class="sr-only"> de ' + esc(vendor.nombre) + ' (abre en otra pestaña)</span> ↗</a>';
    if (editing) html += core.buildAdmin(vendor, 'vendors', false);
    return html + '</article>';
  }

  return { validateVendors: validateVendors, parseVendors: parseVendors, buildVendor: buildVendor };
});
