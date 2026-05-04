function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (req.session.user.role !== "admin") {
    return res.status(403).send("Acceso denegado");
  }

  return next();
}

module.exports = {
  requireAuth,
  requireAdmin
};
