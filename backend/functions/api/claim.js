// POST /api/claim (device bearer token): reserve a scanned QR's request for this station.
exports.handler = require(Runtime.getFunctions()['runtime'].path).deviceHandler('claim');
