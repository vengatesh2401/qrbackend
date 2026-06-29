require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');
const routes = require('./routes');

const app = express();

app.use(cors({ origin: process.env.CORS_ALLOW_ORIGINS || '*' }));
app.use(express.json());

app.use('/', routes);

const PORT = process.env.PORT || 8000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Open this in your browser: http://localhost:${PORT}/\n`);
      console.log(`Dynamic QR backend listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize the database:', err);
    process.exit(1);
  });
