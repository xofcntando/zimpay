const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const { UserError, fmt } = require('./money');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1); // Render terminates TLS
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'"], formAction: ["'self'"] } } }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  app.get('/healthz', async (req, res) => {
    try { await db.cols.users.estimatedDocumentCount(); res.send('ok'); } catch { res.status(500).send('db down'); }
  });

  app.use(session({
    store: MongoStore.create({ client: db.getClient(), dbName: cfg.dbName, collectionName: 'sessions', ttl: 8 * 3600 }),
    secret: cfg.sessionSecret, name: 'zp.sid', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: cfg.isProd, maxAge: 1000 * 60 * 60 * 8 },
  }));

  // CSRF + template locals
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    res.locals.cfg = cfg;
    res.locals.fmt = fmt;
    res.locals.flash = req.session.flash; delete req.session.flash;
    res.locals.user = null;
    if (req.method === 'POST' && !req.path.startsWith('/webhooks/')) {
      const ok = req.body && typeof req.body._csrf === 'string' &&
        req.body._csrf.length === req.session.csrf.length &&
        crypto.timingSafeEqual(Buffer.from(req.body._csrf), Buffer.from(req.session.csrf));
      if (!ok) return res.status(403).render('error', { message: 'Session expired. Go back and try again.' });
    }
    next();
  });

  app.use(async (req, res, next) => {
    try {
      if (req.session.userId && db.isOid(req.session.userId)) {
        const u = await db.cols.users.findOne({ _id: db.oid(req.session.userId) }, { projection: { password_hash: 0 } });
        req.user = u ? { ...u, id: String(u._id) } : null;
        res.locals.user = req.user;
      }
      next();
    } catch (e) { next(e); }
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/wallet'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found' }));
  app.use((err, req, res, next) => {
    if (err instanceof UserError) {
      req.session.flash = { type: 'error', text: err.message };
      return res.redirect(req.get('referer') || '/');
    }
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong on our side.' });
  });
  return app;
}

async function main() {
  await db.init();
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`${cfg.appName} listening on ${port} (provider=${cfg.provider})`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { createApp };
