import passport from 'passport'

export function requireAuth(req, res, next) {
  passport.authenticate('jwt', { session: false }, (err, user) => {
    if (err) return next(err)
    if (!user) return res.status(401).json({ message: 'Unauthorized' })
    req.user = user
    next()
  })(req, res, next)
}

export function requireTeacher(req, res, next) {
  const user = req.user
  if (user.role !== 'teacher') {
    return res.status(403).json({ message: 'Teacher access required' })
  }
  next()
}

export function getUser(req) {
  return req.user
}
