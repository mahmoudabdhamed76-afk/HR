const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const root = __dirname;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function safeJoin(base, target) {
  const targetPath = '.' + path.posix.normalize('/' + target).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(base, targetPath);
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = safeJoin(root, urlPath);
    const ext = path.extname(filePath).toLowerCase();

    fs.readFile(filePath, (err, data) => {
      if (!err) {
        res.statusCode = 200;
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.end(data);
        return;
      }

      // SPA fallback
      fs.readFile(path.join(root, 'index.html'), (indexErr, indexData) => {
        if (indexErr) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('index.html not found');
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(indexData);
      });
    });
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EmdadX HR running on port ${PORT}`);
});
