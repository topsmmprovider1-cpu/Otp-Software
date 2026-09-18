const { createServer } = require('../tests/mock-sms');
createServer().listen(5099, () => console.log('mock up on 5099'));