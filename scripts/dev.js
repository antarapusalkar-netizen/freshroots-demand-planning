// Local server: serves the dashboard page and runs the /api handlers. Same handlers Vercel will run.
import { createServer } from 'node:http';

const port = Number(process.env.PORT) || 3000;
const root = new URL('../', import.meta.url);

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    if (path === '/' || path === '/deepa') {
      if (path === '/deepa') req.url = '/api/page?view=deepa';
      await (await import(new URL('api/page.js', root))).default(req, res);
    } else if (/^\/api\/[a-z]+$/.test(path)) {
      const mod = await import(new URL(`api/${path.slice(5)}.js`, root));
      await mod.default(req, res);
    } else {
      res.statusCode = 404;
      res.end('Not found');
    }
  } catch (e) {
    res.statusCode = e.code === 'ERR_MODULE_NOT_FOUND' ? 404 : 500;
    res.end(res.statusCode === 404 ? 'Not found' : 'Server error');
  }
}).listen(port, () => console.log(`Freshroots dev server on http://localhost:${port}`));
