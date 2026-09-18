const { init } = require('../src/app');

let appPromise = null;

module.exports = async (req, res) => {
  if (!appPromise) {
    appPromise = init();
  }
  try {
    const app = await appPromise;
    app(req, res);
  } catch (err) {
    console.error('Serverless init error:', err);
    res.status(500).json({ error: 'Server initialization failed: ' + err.message });
  }
};
