// vm/weredevs/index.js
'use strict';
module.exports = {
  ...require('./extractor'),
  ...require('./opcodeMap'),
  ...require('./interpreterParser'),
  ...require('./decompiler'),
};
