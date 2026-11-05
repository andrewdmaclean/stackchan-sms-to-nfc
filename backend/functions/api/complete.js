// POST /api/complete (device bearer token): record a verified NFC write; safe to retry.
exports.handler = require(Runtime.getFunctions()['runtime'].path).deviceHandler('complete');
