const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(404).render('error', { message: 'Page not found' }));
const flash = (req, type, text) => { req.session.flash = { type, text }; };
module.exports = { wrap, requireLogin, requireAdmin, flash };
