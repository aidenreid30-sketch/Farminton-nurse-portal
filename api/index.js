'use strict';

// Vercel function. vercel.json sends every request (except /static files) here.

const { createHandler } = require('../lib/handler');
const { storeFromEnv } = require('../lib/store');

let handler;

module.exports = (req, res) => {
  handler = handler || createHandler({ env: process.env, store: storeFromEnv(process.env) });
  return handler(req, res);
};
