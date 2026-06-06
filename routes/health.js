const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.type('text/plain').status(200).send('OK');
});

module.exports = router;
