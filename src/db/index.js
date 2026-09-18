const config = require('../config');

const db = config.dbMode === 'supabase' ? require('./supabase') : require('./sqlite');

module.exports = db;
module.exports.mode = config.dbMode;