'use strict';

var validation = require('./validation');
var vendors = require('../../assets/js/vendors-core');

// One scope owns exactly one JSON file and image directory.
module.exports = {
  studies: { path: 'data/estudios.json', directory: 'estudios', validate: validation.validateStudies },
  colombia: { path: 'data/colombia.json', directory: 'colombia', validate: validation.validateColombia },
  vendors: { path: 'data/vendors.json', directory: 'vendors', validate: vendors.validateVendors }
};
